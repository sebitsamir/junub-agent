#!/usr/bin/env node
import { createInterface } from 'node:readline';
import path from 'node:path';
import { appendFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { inspect } from './lib/inspect.mjs';
import { verify } from './lib/verify.mjs';
import { inspectFilmProject, verifyMediaLinks, applyFilmPatch } from '../packs/film/dist/index.js';
import { serializeProtocolMessage, parseProtocolMessage } from '../packages/contracts/dist/index.js';
import { runTask, InMemoryActionGuard, FileEventStore } from '../packages/kernel/dist/index.js';
import { makeStepAction } from './lib/actions.mjs';
import { CapabilityRouter, generateReadOnlyPlan, compilePlan } from '../packages/models/dist/index.js';
import { selectModelProvider } from './lib/providers.mjs';

const rl = createInterface({ input: process.stdin, terminal: false });
const TASK_LOG_DIR = process.env.JUNUB_TASK_LOG_DIR || path.join('.junub', 'tasks');
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const HISTORY_FILE = path.join(ROOT_DIR, '.junub', 'history.jsonl');

process.stderr.write('[engine] History file target: ' + HISTORY_FILE + '\n');

async function logHistory(record) {
  try {
    await mkdir(path.dirname(HISTORY_FILE), { recursive: true });
    await appendFile(HISTORY_FILE, JSON.stringify(record) + '\n');
  } catch (err) {
    process.stderr.write('[engine] Failed to write history: ' + err.message + '\n');
  }
}

class StreamingEventStore extends FileEventStore {
  constructor(filePath, emit) {
    super(filePath);
    this.emit = emit;
  }
  async appendTaskEvent(request) {
    const stored = await super.appendTaskEvent(request);
    this.emit({
      protocolVersion: 1, taskId: stored.taskId, sequence: stored.sequence,
      eventId: stored.eventId, type: stored.type, payload: stored.payload, timestamp: stored.occurredAt,
    });
    return stored;
  }
}

async function executeRealTask(taskId, contract, plan) {
  const emit = (evt) => {
    try { process.stdout.write(serializeProtocolMessage(evt) + '\n'); }
    catch (e) { process.stderr.write('[engine] emit failed: ' + e.message + '\n'); }
  };
  const filePath = path.join(TASK_LOG_DIR, taskId + '.jsonl');
  const eventStore = new StreamingEventStore(filePath, emit);
  const actionGuard = new InMemoryActionGuard();
  const plannedSteps = Array.isArray(plan) ? plan : contract.acceptance.map((c) => ({
    stepId: c.id, statement: c.statement, action: { kind: 'noop', params: { statement: c.statement } },
  }));
  const steps = plannedSteps.map((s) => ({
    stepId: s.stepId || s.id || 'step-' + Math.random().toString(36).slice(2),
    statement: s.statement || s.stepId || s.id, action: makeStepAction(s.action),
  }));

  try {
    await runTask({ taskId, steps, eventStore, actionGuard });
    await logHistory({
      timestamp: new Date().toISOString(), taskId, event: 'task_completed',
      contract: { title: contract.title, intent: contract.intent, domain: contract.domain },
      status: 'succeeded', executedSteps: steps.map((s) => ({ stepId: s.stepId, statement: s.statement, kind: s.action.kind })),
    });
  } catch (err) {
    process.stderr.write('[engine] task execution error: ' + err.message + '\n');
    await logHistory({
      timestamp: new Date().toISOString(), taskId, event: 'task_failed',
      contract: { title: contract.title, intent: contract.intent, domain: contract.domain },
      status: 'failed', error: err.message,
    });
  }
}

rl.on('line', async (line) => {
  let request;
  try {
    request = parseProtocolMessage(line);
    if (!request.requestId || !request.method) throw new Error('Missing requestId or method');
  } catch (err) {
    process.stdout.write(serializeProtocolMessage({
      protocolVersion: 1, requestId: 'unknown', success: false,
      error: { code: 'PROTOCOL_MALFORMED', message: err.message }, timestamp: new Date().toISOString(),
    }) + '\n');
    return;
  }

  let result;
  let success = true;
  let errorPayload;

  try {
    if (request.method === 'pack.software.inspect') {
      result = await inspect(request.params?.path || '.');
    } else if (request.method === 'pack.software.verify') {
      result = await verify(request.params?.path || '.', request.params?.scripts || []);
    } else if (request.method === 'pack.film.inspect') {
      result = await inspectFilmProject(request.params?.path || '.');
    } else if (request.method === 'pack.film.verify') {
      result = await verifyMediaLinks(request.params?.path || '.');
    } else if (request.method === 'workspace.detectLanguage') {
      const { detectLanguageAndFramework } = await import('./lib/language-detector.mjs');
      result = await detectLanguageAndFramework(request.params?.path || process.cwd());
    } else if (request.method === 'workspace.resolveCommand') {
      const { intent, workspacePath } = request.params || {};
      if (!intent) throw new Error('Missing intent');
      const { detectLanguageAndFramework } = await import('./lib/language-detector.mjs');
      const { resolveCommand } = await import('./lib/command-resolver.mjs');
      const detection = await detectLanguageAndFramework(workspacePath || process.cwd());
      const resolved = resolveCommand(intent, detection);
      result = resolved ? { success: true, command: resolved.command, args: resolved.args, description: resolved.description, detectedEcosystem: detection.primaryEcosystem }
                        : { success: false, message: `Could not resolve command for intent: "${intent}".` };
    } else if (request.method === 'pack.film.applyPatch') {
      result = await applyFilmPatch(request.params?.path || '.', request.params?.patch, { allowDirty: request.params?.allowDirty === true });
    } else if (request.method === 'pack.film.fix') {
      const { path: projectPath } = request.params || {};
      const { inspectFilmProject } = await import('../packs/film/dist/index.js');
      const pathModule = await import('node:path');
      const report = await inspectFilmProject(projectPath || '.');
      const allClips = report.clips || [];
      const missingClips = allClips.filter(c => !c.mediaExists && c.source === 'timeline');
      const availableClips = allClips.filter(c => c.mediaExists && c.source === 'raw_media');

      if (missingClips.length === 0) {
        result = { missingClips: [], proposedRelsinks: [], timelinePath: null };
      } else {
        const edlTimeline = report.timelines.find(t => t.format === 'edl');
        const timelinePath = edlTimeline ? pathModule.join(projectPath || '.', edlTimeline.path) : null;
        const { provider, model } = selectModelProvider();
        const router = new CapabilityRouter([provider]);
        await router.refreshModels();

        const response = await provider.complete({
          modelId: model || 'qwen/qwen-2.5-72b-instruct',
          messages: [
            { role: 'system', content: 'You are a film editor assistant. Match missing media to available media. Output ONLY a valid JSON array like: [{"missingFile": "a.mp4", "availableFile": "b.mp4"}].' },
            { role: 'user', content: 'MISSING:\n' + missingClips.map(c => c.clipName).join('\n') + '\n\nAVAILABLE:\n' + availableClips.map(c => c.clipName).join('\n') }
          ],
          temperature: 0.1, maxOutputTokens: 512,
        });

        let cleaned = response.content.trim().replace(/^```json\s*/, '').replace(/\s*```$/, '').replace(/^```\s*/, '').replace(/\s*```$/, '');
        const firstBracket = cleaned.indexOf('[');
        const lastBracket = cleaned.lastIndexOf(']');
        if (firstBracket !== -1 && lastBracket > firstBracket) cleaned = cleaned.substring(firstBracket, lastBracket + 1);

        let proposedRelsinks = [];
        try { proposedRelsinks = JSON.parse(cleaned); } catch (e) { proposedRelsinks = []; }
        result = { missingClips: missingClips.map(c => ({ clipName: c.clipName, mediaPath: c.mediaPath })), proposedRelsinks, timelinePath };
      }
    } else if (request.method === 'pack.film.applyFix') {
      const { path: projectPath, timelinePath, relinks } = request.params || {};
      const { readFile, writeFile } = await import('node:fs/promises');
      const { inspectFilmProject } = await import('../packs/film/dist/index.js');
      if (!timelinePath || !relinks || relinks.length === 0) throw new Error('Missing timelinePath or relinks');

      let edlContent = await readFile(timelinePath, 'utf8');
      await writeFile(timelinePath + '.bak', edlContent, 'utf8');
      let fixedCount = 0;
      for (const relink of relinks) {
        if (edlContent.includes(relink.missingFile)) {
          edlContent = edlContent.replace(relink.missingFile, relink.availableFile);
          fixedCount++;
        }
      }
      await writeFile(timelinePath, edlContent, 'utf8');
      const verifyReport = await inspectFilmProject(projectPath || '.');
      const stillMissing = (verifyReport.clips || []).filter(c => !c.mediaExists && c.source === 'timeline');

      if (stillMissing.length > 0) {
        await writeFile(timelinePath, await readFile(timelinePath + '.bak', 'utf8'), 'utf8');
        result = { success: false, fixedCount, error: 'Verification failed. ' + stillMissing.length + ' media files still missing.', reverted: true };
      } else {
        result = { success: true, fixedCount, error: null, reverted: false };
      }
    } else if (request.method === 'chat.run') {
      const { command, args, cwd } = request.params || {};
      if (!command) throw new Error('Missing command');
      const { run } = await import('./lib/process.mjs');
      const workDir = cwd || process.cwd();
      process.stderr.write(`[engine] Running: ${command} ${args.join(' ')} in ${workDir}\n`);
      result = await run(command, args || [], workDir, { timeoutMs: 120000, maxOutputBytes: 131072, shell: true });
      result.success = result.exitCode === 0 && !result.error && !result.timedOut;
    } else if (request.method === 'chat.diagnose') {
      const { command, stdout, stderr } = request.params || {};
      const { provider, model } = selectModelProvider();
      const router = new CapabilityRouter([provider]);
      await router.refreshModels();
      const errorText = ((stderr || '') + '\n' + (stdout || '')).replace(/\x1b\[[0-9;]*m/g, '').slice(-4000);

      const response = await provider.complete({
        modelId: model || 'qwen/qwen-2.5-72b-instruct',
        messages: [
          { role: 'system', content: 'CRITICAL: You are a strict JSON-only debugging engine. Output ONLY a valid JSON object. If fixable, output: {"actions": [{"type": "run", "command": "npm", "args": ["install", "pkg"]}, {"type": "edit", "filePath": "file.js", "instruction": "fix syntax"}]}. If unfixable, output: {"fallbackInstruction": "Reason"}.' },
          { role: 'user', content: `Command: ${command}\n\nError Output:\n${errorText}` }
        ],
        temperature: 0.1, maxOutputTokens: 512,
      });

      let cleaned = response.content.trim().replace(/^```json\s*/, '').replace(/\s*```$/, '').replace(/^```\s*/, '').replace(/\s*```$/, '');
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace > firstBrace) cleaned = cleaned.substring(firstBrace, lastBrace + 1);

      try { result = JSON.parse(cleaned); }
      catch (e) { result = { actions: [], fallbackInstruction: 'Failed to parse diagnosis: ' + cleaned }; }
    } else if (request.method === 'chat.edit') {
      const { filePath, instruction, fileContent } = request.params || {};
      if (!filePath || !instruction) throw new Error('Missing filePath or instruction');

      const { provider, model } = selectModelProvider();
      const router = new CapabilityRouter([provider]);
      await router.refreshModels();

      const response = await provider.complete({
        modelId: model || 'qwen/qwen-2.5-72b-instruct',
        messages: [
          { role: 'system', content: 'You are an expert code-editing AI. Output ONLY a SEARCH/REPLACE block. Format:\n<<<<<<< SEARCH\n[exact lines]\n=======\n[new lines]\n>>>>>>> REPLACE\nNo explanations, no markdown outside the block.' },
          { role: 'user', content: `FILE PATH: ${filePath}\n\nINSTRUCTION: ${instruction}\n\nCURRENT FILE CONTENT:\n${fileContent || '(empty file)'}\n\nOUTPUT THE SEARCH/REPLACE BLOCK NOW:` }
        ],
        temperature: 0.1, maxOutputTokens: 2048,
      });

      let rawOutput = response.content.trim().replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '');
      let editedContent = fileContent || '';
      let appliedCount = 0;

      const sanitizeOutput = (text) => {
        let c = text.trim();
        if (c.startsWith('[') && !c.includes('module.exports')) c = c.replace(/^\[\s*/, '');
        if (c.endsWith(']') && !c.includes('module.exports')) c = c.replace(/\s*\]$/, '');
        if (c.startsWith('{') && c.includes('"content"')) {
          try { const p = JSON.parse(c); if (typeof p.content === 'string') c = p.content; } catch {}
        }
        return c.replace(/^```(?:typescript|ts|javascript|js)?\n?/, '').replace(/\n?```$/, '').trim();
      };

      const applyPatch = (searchBlock, replaceBlock) => {
        replaceBlock = sanitizeOutput(replaceBlock);

        // Special case: Creating a new file or the file is currently empty
        if (editedContent.trim() === '' && (searchBlock.trim() === '' || searchBlock.trim() === '[empty file]')) {
          editedContent = replaceBlock;
          appliedCount++;
          return true;
        }

        if (editedContent.includes(searchBlock)) {
          editedContent = editedContent.replace(searchBlock, replaceBlock);
          appliedCount++;
          return true;
        }
        const searchLines = searchBlock.split('\n').map(l => l.trim()).filter(l => l);
        if (searchLines.length === 0) return false;
        const fileLines = editedContent.split('\n');
        for (let i = 0; i <= fileLines.length - searchLines.length; i++) {
          let matchAll = true;
          for (let j = 0; j < searchLines.length; j++) {
            if (fileLines[i + j].trim() !== searchLines[j]) { matchAll = false; break; }
          }
          if (matchAll) {
            fileLines.splice(i, searchLines.length, ...replaceBlock.split('\n'));
            editedContent = fileLines.join('\n');
            appliedCount++;
            return true;
          }
        }
        return false;
      };

      const strictRegex = /<<<<<<< SEARCH\n([\s\S]*?)\n?=======\n([\s\S]*?)\n?>>>>>>> REPLACE/g;
      let match;
      while ((match = strictRegex.exec(rawOutput)) !== null) applyPatch(match[1], match[2]);

      if (appliedCount === 0) {
        const simpleRegex = /SEARCH:\s*\n([\s\S]*?)\nREPLACE:\s*\n([\s\S]*?)(?=\nSEARCH:|$)/gi;
        while ((match = simpleRegex.exec(rawOutput)) !== null) applyPatch(match[1], match[2]);
      }

      if (appliedCount === 0) throw new Error('Failed to apply changes. Raw output:\n' + rawOutput.slice(0, 500));

      // SAFE CONFIG FILE SANITIZATION (Simple string replacement, zero regex syntax risk)
      let finalContent = editedContent;
      if (filePath.endsWith('jest.config.js') || filePath.endsWith('jest.config.ts')) {
        if (finalContent.includes("'^.+\\.tsx?") && !finalContent.includes("'^.+\\\\.tsx?$'")) {
          finalContent = finalContent.split("'^.+\\.tsx?").join("'^.+\\\\.tsx?$'");
        }
        if (finalContent.includes("'^.+\\\\.tsx?") && !finalContent.includes("'^.+\\\\.tsx?$'")) {
          finalContent = finalContent.split("'^.+\\\\.tsx?").join("'^.+\\\\.tsx?$'");
        }
        process.stderr.write('[engine] Applied safe jest.config.js regex repair.\n');
      }

      if (filePath.endsWith('package.json')) {
        try { JSON.parse(finalContent); } catch {
          finalContent = finalContent.replace(/,\s*([\]}])/g, '$1');
          process.stderr.write('[engine] Auto-repaired invalid JSON (trailing comma) in package.json\n');
        }
      }

      result = { filePath, originalContent: fileContent || '', editedContent: finalContent, instruction, modelUsed: model || 'unknown' };
    } else if (request.method === 'chat.query') {
      const { message, history, workspaceContext } = request.params || {};
      if (!message) throw new Error('Missing message');

      const { provider, source, model } = selectModelProvider();
      const router = new CapabilityRouter([provider]);
      await router.refreshModels();

      const historyText = history && history.length > 0 ? history.map((h) => h.role + ': ' + h.content).join('\n') : '';
      let frameworkContext = '';
      if (workspaceContext && workspaceContext.includes('Frameworks:')) {
        const frameworksMatch = workspaceContext.match(/Frameworks:\s*([^\n]+)/);
        if (frameworksMatch && frameworksMatch[1]) {
          const { generateFrameworkContext } = await import('./lib/framework-prompts.mjs');
          frameworkContext = generateFrameworkContext(frameworksMatch[1].split(',').map(f => f.trim()));
        }
      }

      // CORRECTED STRING LITERAL: No unescaped newlines, properly escaped inner quotes
      const systemContent = '*** MANDATORY PRE-FLIGHT ENVIRONMENT CHECK ***\n' +
        'Before generating ANY action plan, you MUST analyze the workspace context.\n' +
        'If the user asks to ADD, CREATE, or IMPLEMENT tests, verify:\n' +
        '1. Is the test runner (jest, vitest, pytest) installed? If NO, your FIRST action MUST be to install it.\n' +
        '2. Does the "test" script exist in package.json? If NO, your SECOND action MUST be to add it.\n' +
        '3. If TypeScript, is ts-jest installed and configured? If NO, install ts-jest and create jest.config.js BEFORE creating the test file.\n' +
        'NEVER assume the testing environment is set up.\n\n' +
        '*** PROFESSIONAL CODE GENERATION RULES ***\n' +
        '1. SELF-CONTAINED TESTS: If you create a test file, either include an edit action to create the source file, OR define the functions directly inside the test file. NEVER import a non-existent local file.\n' +
        '2. ANTI-HALLUCINATION: NEVER run "npm install" to fix a "Cannot find module" error for a relative path (starts with "./" or "../"). Relative paths are local files. Create them instead.\n' +
        '3. TESTING LIBRARY RULE: When creating test files, you MUST use ONLY native Jest "expect" or Node\'s built-in "assert". NEVER import external assertion libraries like "chai", "should", or "mocha". They cause ESM transformation errors in Jest.\n\n' +
        'You are Junub Agent. CRITICAL RULE: If the user asks you to implement, create, fix, apply, or do something, ' +
        'you MUST output a valid JSON object with an "actions" array detailing the exact steps. ' +
        'Format EXACTLY like this JSON (no markdown, no extra text):\n' +
        '{\n  "actions": [\n' +
        '    {"type": "edit", "filePath": "package.json", "instruction": "Add a test script using jest"},\n' +
        '    {"type": "run", "command": "npm", "args": ["install", "--save-dev", "jest"]},\n' +
        '    {"type": "edit", "filePath": "__tests__/sample.test.js", "instruction": "Create a basic sample test file that passes"},\n' +
        '    {"type": "run", "command": "npm", "args": ["test"]}\n' +
        '  ]\n}\n' +
        'IMPORTANT: NEVER hallucinate file paths. Use ONLY files listed in the workspace context.\n' +
        (frameworkContext ? '\n\nFRAMEWORK-SPECIFIC RULES:\n' + frameworkContext : '');

      let systemDirective = '';
      const lowerMsg = message.toLowerCase();
      if (workspaceContext && (lowerMsg.includes('test') || lowerMsg.includes('testing'))) {
        const isTypeScript = workspaceContext.includes('typescript') || workspaceContext.includes('tsconfig.json');
        const hasTsJest = workspaceContext.includes('ts-jest');
        const hasJestConfig = workspaceContext.includes('jest.config');
        const hasTestScript = /"test"\s*:\s*"jest"/.test(workspaceContext) || /"test"\s*:\s*"vitest"/.test(workspaceContext);
        let missing = [];
        if (!workspaceContext.includes('jest') && !workspaceContext.includes('vitest')) missing.push('Run: npm install --save-dev jest');
        if (isTypeScript && !hasTsJest) missing.push('Run: npm install --save-dev ts-jest @types/jest');
        if (isTypeScript && !hasJestConfig) missing.push('Create jest.config.js with: module.exports = { preset: "ts-jest", testEnvironment: "node" };');
        if (!hasTestScript) missing.push('Add "test": "jest" to package.json scripts');

        if (missing.length > 0) {
          systemDirective = '\n\n[SYSTEM DIRECTIVE - MANDATORY COMPLIANCE]\n' +
            'The workspace is missing critical testing infrastructure. Your "actions" array MUST include these setup steps FIRST:\n' +
            missing.map((m, i) => (i + 1) + '. ' + m).join('\n') +
            '\nDo NOT skip these steps. The environment MUST be fully configured in your plan.';
        }
      }

      const response = await provider.complete({
        modelId: model || 'qwen/qwen-2.5-72b-instruct',
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: `WORKSPACE CONTEXT:\n${workspaceContext || 'No workspace open.'}\n\nCONVERSATION HISTORY:\n${historyText || 'No previous messages.'}\n\nUSER REQUEST:\n${message}${systemDirective}` }
        ],
        temperature: 0.1, maxOutputTokens: 2048,
      });

      let responseText = response.content.trim().replace(/^```json\s*/, '').replace(/\s*```$/, '').replace(/^```\s*/, '').replace(/\s*```$/, '');
      let isActionPlan = false;
      try {
        const firstBrace = responseText.indexOf('{');
        const lastBrace = responseText.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace > firstBrace) {
          const parsed = JSON.parse(responseText.substring(firstBrace, lastBrace + 1));
          if (parsed.actions && Array.isArray(parsed.actions)) {
            const hasInstall = parsed.actions.some(a => a.type === 'run' && a.args && a.args.some(arg => arg.includes('jest') || arg.includes('vitest')));
            const hasTsJest = parsed.actions.some(a => a.type === 'run' && a.args && a.args.some(arg => arg.includes('ts-jest')));
            const isTypeScript = workspaceContext && (workspaceContext.toLowerCase().includes('typescript') || workspaceContext.includes('.ts'));
            const hasJestConfig = parsed.actions.some(a => a.type === 'edit' && a.filePath.includes('jest.config'));

            let injectedSteps = [];
            if (isTypeScript && !hasTsJest) injectedSteps.push({ type: 'run', command: 'npm', args: ['install', '--save-dev', 'jest', 'ts-jest', '@types/jest'] });
            else if (!hasInstall) injectedSteps.push({ type: 'run', command: 'npm', args: ['install', '--save-dev', 'jest'] });
            if (isTypeScript && !hasJestConfig) injectedSteps.push({ type: 'edit', filePath: 'jest.config.js', instruction: 'Create jest config with ts-jest preset' });

            if (injectedSteps.length > 0) {
              parsed.actions = [...injectedSteps, ...parsed.actions];
              process.stderr.write(`[engine] Auto-injected ${injectedSteps.length} missing environment setup steps.\n`);
            }
            isActionPlan = true;
            result = { isActionPlan: true, actions: parsed.actions, modelUsed: model || 'unknown' };
          }
        }
      } catch (e) {
        process.stderr.write('[engine] chat.query JSON parse failed: ' + e.message + '\n');
      }

      if (!isActionPlan) result = { isActionPlan: false, response: responseText, modelUsed: model || 'unknown' };
    } else if (request.method === 'task.refine') {
      const { message, history, workspaceContext } = request.params || {};
      if (!message) throw new Error('Missing message for refinement');
      const { provider, source, model } = selectModelProvider();
      const router = new CapabilityRouter([provider]);
      await router.refreshModels();
      const historyText = history && history.length > 0 ? `Previous context:\n${history.map((h) => `${h.role}: ${h.content}`).join('\n')}` : 'No previous context.';
      const contextBlock = workspaceContext ? `\n\nCURRENT WORKSPACE CONTEXT:\n${workspaceContext}` : '';

      const response = await provider.complete({
        modelId: model || 'qwen/qwen-2.5-72b-instruct',
        messages: [
          { role: 'system', content: `You are an AI agent coordinator. Convert the request into a JSON object. Output ONLY valid JSON.\n${contextBlock}\n\nIf clear, output: {"contract": {"taskId": "chat-1", "title": "Short Title", "intent": "Clear intent", "domain": "software", "impact": "low", "outputs": [], "acceptance": [{"id": "a1", "statement": "First measurable criterion"}]}}\nIf vague, output: {"question": "What specific part should I focus on?"}` },
          { role: 'user', content: `${historyText}\n\nUser request: ${message}` }
        ],
        temperature: 0.1, maxOutputTokens: 512,
      });

      let cleaned = response.content.trim().replace(/^```json\s*/, '').replace(/\s*```$/, '').replace(/^```\s*/, '').replace(/\s*```$/, '');
      try {
        result = JSON.parse(cleaned);
        process.stderr.write('[engine] task.refine RAW OUTPUT: ' + cleaned + '\n');
      } catch (err) {
        throw new Error(`Failed to parse refinement JSON: ${err.message}. Raw: ${cleaned.slice(0, 200)}`);
      }
    } else if (request.method === 'task.plan') {
      const contract = request.params?.contract;
      if (!contract || !Array.isArray(contract.acceptance)) throw new Error('Invalid task contract: missing acceptance criteria');
      const { provider, source } = selectModelProvider();
      const router = new CapabilityRouter([provider]);
      await router.refreshModels();
      result = await generateReadOnlyPlan(contract, { router });
      await logHistory({
        timestamp: new Date().toISOString(), taskId: contract.taskId || 'unknown', event: 'plan_generated',
        contract: { title: contract.title, intent: contract.intent, domain: contract.domain },
        planStepsCount: result.steps ? result.steps.length : 0, modelUsed: result.modelUsed || source,
        plan: result.steps || null, refusal: result.reason ? { reason: result.reason, message: result.message, suggestedNextAction: result.suggestedNextAction } : null,
      });
    } else if (request.method === 'task.compile') {
      const plan = request.params?.plan;
      const context = request.params?.context;
      if (!plan || !context) throw new Error('Missing plan or context for compilation');
      result = compilePlan(plan, context);
    } else if (request.method === 'task.run') {
      const contract = request.params?.contract;
      if (!contract || !Array.isArray(contract.acceptance)) throw new Error('Invalid task contract: missing acceptance criteria');
      const taskId = contract.taskId || 'task-' + Date.now();
      process.stdout.write(serializeProtocolMessage({ protocolVersion: 1, requestId: request.requestId, success: true, result: { taskId, status: 'accepted' }, timestamp: new Date().toISOString() }) + '\n');
      executeRealTask(taskId, contract, request.params?.plan);
      return;
    } else {
      throw new Error('Unknown method: ' + request.method);
    }
  } catch (err) {
    success = false;
    let errorMessage = err.message || 'Unknown error';
    if (errorMessage.includes('429') || errorMessage.includes('rate-limited') || errorMessage.includes('engine_overloaded')) {
      errorMessage = 'Rate limit reached. The free OpenRouter shared pool is currently overloaded. Please wait or configure your own API key.';
    }
    if (errorMessage.includes('fetch failed') || errorMessage.includes('ENOTFOUND') || errorMessage.includes('ECONNREFUSED')) {
      errorMessage = 'Network error. Unable to reach the AI provider. Check your internet connection or local Ollama server.';
    }
    errorPayload = { code: err.code || 'UNKNOWN_ERROR', message: errorMessage };
  }

  process.stdout.write(serializeProtocolMessage({
    protocolVersion: 1, requestId: request.requestId, success,
    ...(success ? { result } : { error: errorPayload }), timestamp: new Date().toISOString(),
  }) + '\n');
});

process.stderr.write('[engine] Junub Agent headless engine started.\n');
