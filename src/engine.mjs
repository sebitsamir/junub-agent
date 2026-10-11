#!/usr/bin/env node
import { createInterface } from 'node:readline';
import path from 'node:path';
import { appendFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Domain packs
import { inspect } from './lib/inspect.mjs';
import { verify } from './lib/verify.mjs';
import { inspectFilmProject, verifyMediaLinks, applyFilmPatch } from '../packs/film/dist/index.js';

// Protocol & Contracts
import {
  serializeProtocolMessage,
  parseProtocolMessage,
} from '../packages/contracts/dist/index.js';

// Kernel Execution
import {
  runTask,
  InMemoryActionGuard,
  FileEventStore,
} from '../packages/kernel/dist/index.js';
import { makeStepAction } from './lib/actions.mjs';

// Models (Planning & Routing)
import {
  CapabilityRouter,
  generateReadOnlyPlan,
  compilePlan,
} from '../packages/models/dist/index.js';
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
    process.stderr.write('[engine] History logged successfully.\n');
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
      protocolVersion: 1,
      taskId: stored.taskId,
      sequence: stored.sequence,
      eventId: stored.eventId,
      type: stored.type,
      payload: stored.payload,
      timestamp: stored.occurredAt,
    });
    return stored;
  }
}

async function executeRealTask(taskId, contract, plan) {
  const emit = (evt) => {
    try {
      process.stdout.write(serializeProtocolMessage(evt) + '\n');
    } catch (e) {
      process.stderr.write('[engine] emit failed: ' + e.message + '\n');
    }
  };

  const filePath = path.join(TASK_LOG_DIR, taskId + '.jsonl');
  const eventStore = new StreamingEventStore(filePath, emit);
  const actionGuard = new InMemoryActionGuard();

  const plannedSteps = Array.isArray(plan)
    ? plan
    : contract.acceptance.map((c) => ({
      stepId: c.id,
      statement: c.statement,
      action: { kind: 'noop', params: { statement: c.statement } },
    }));

  const steps = plannedSteps.map((s) => ({
    stepId: s.stepId || s.id || 'step-' + Math.random().toString(36).slice(2),
    statement: s.statement || s.stepId || s.id,
    action: makeStepAction(s.action),
  }));

  try {
    await runTask({ taskId, steps, eventStore, actionGuard });
    await logHistory({
      timestamp: new Date().toISOString(),
      taskId,
      event: 'task_completed',
      contract: { title: contract.title, intent: contract.intent, domain: contract.domain },
      status: 'succeeded',
      executedSteps: steps.map((s) => ({ stepId: s.stepId, statement: s.statement, kind: s.action.kind })),
    });
  } catch (err) {
    process.stderr.write('[engine] task execution error: ' + err.message + '\n');
    await logHistory({
      timestamp: new Date().toISOString(),
      taskId,
      event: 'task_failed',
      contract: { title: contract.title, intent: contract.intent, domain: contract.domain },
      status: 'failed',
      error: err.message,
    });
  }
}

rl.on('line', async (line) => {
  let request;

  try {
    request = parseProtocolMessage(line);
    if (!request.requestId || !request.method) {
      throw new Error('Missing requestId or method');
    }
  } catch (err) {
    process.stdout.write(
      serializeProtocolMessage({
        protocolVersion: 1,
        requestId: 'unknown',
        success: false,
        error: { code: 'PROTOCOL_MALFORMED', message: err.message },
        timestamp: new Date().toISOString(),
      }) + '\n'
    );
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
      const { path: workspacePath } = request.params || {};
      const { detectLanguageAndFramework } = await import('./lib/language-detector.mjs');
      result = await detectLanguageAndFramework(workspacePath || process.cwd());
    } else if (request.method === 'workspace.resolveCommand') {
      const { intent, workspacePath } = request.params || {};
      if (!intent) throw new Error('Missing intent');

      const { detectLanguageAndFramework } = await import('./lib/language-detector.mjs');
      const { resolveCommand } = await import('./lib/command-resolver.mjs');

      const detection = await detectLanguageAndFramework(workspacePath || process.cwd());
      const resolved = resolveCommand(intent, detection);

      if (!resolved) {
        result = {
          success: false,
          message: `Could not resolve command for intent: "${intent}". Detected ecosystem: ${detection.primaryEcosystem || 'unknown'}.`
        };
      } else {
        result = {
          success: true,
          command: resolved.command,
          args: resolved.args,
          description: resolved.description,
          detectedEcosystem: detection.primaryEcosystem
        };
      }
    } else if (request.method === 'pack.film.applyPatch') {
      result = await applyFilmPatch(
        request.params?.path || '.',
        request.params?.patch,
        { allowDirty: request.params?.allowDirty === true },
      );
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

        const missingList = missingClips.map(c => c.clipName).join('\n');
        const availableList = availableClips.map(c => c.clipName).join('\n');

        const system = 'You are a film editor assistant. You are given a list of missing media files referenced in an EDL timeline, and a list of available media files on disk. ' +
          'Match each missing file to the most appropriate available file. ' +
          'Output ONLY a valid JSON array of objects like: [{"missingFile": "missing.mp4", "availableFile": "existing.mp4"}]. ' +
          'If there are more missing files than available files, reuse available files as needed. ' +
          'If there are no available files, return an empty array.';

        const user = 'MISSING MEDIA FILES:\n' + missingList + '\n\nAVAILABLE MEDIA FILES:\n' + availableList;

        const response = await provider.complete({
          modelId: model || 'qwen/qwen-2.5-72b-instruct',
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          temperature: 0.1,
          maxOutputTokens: 512,
        });

        let cleaned = response.content.trim();
        if (cleaned.startsWith('```json')) cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
        else if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');

        const firstBracket = cleaned.indexOf('[');
        const lastBracket = cleaned.lastIndexOf(']');
        if (firstBracket !== -1 && lastBracket > firstBracket) {
          cleaned = cleaned.substring(firstBracket, lastBracket + 1);
        }

        let proposedRelsinks = [];
        try {
          proposedRelsinks = JSON.parse(cleaned);
        } catch (e) {
          proposedRelsinks = [];
        }

        result = {
          missingClips: missingClips.map(c => ({ clipName: c.clipName, mediaPath: c.mediaPath })),
          proposedRelsinks,
          timelinePath,
        };
      }
    } else if (request.method === 'pack.film.applyFix') {
      const { path: projectPath, timelinePath, relinks } = request.params || {};
      const { readFile, writeFile } = await import('node:fs/promises');
      const { inspectFilmProject } = await import('../packs/film/dist/index.js');

      if (!timelinePath || !relinks || relinks.length === 0) {
        throw new Error('Missing timelinePath or relinks');
      }

      let edlContent = await readFile(timelinePath, 'utf8');
      const backupPath = timelinePath + '.bak';
      await writeFile(backupPath, edlContent, 'utf8');

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
        await writeFile(timelinePath, await readFile(backupPath, 'utf8'), 'utf8');
        result = {
          success: false,
          fixedCount,
          error: 'Verification failed. ' + stillMissing.length + ' media files still missing after patch.',
          reverted: true,
        };
      } else {
        result = {
          success: true,
          fixedCount,
          error: null,
          reverted: false,
        };
      }
    } else if (request.method === 'chat.run') {
      const { command, args, cwd } = request.params || {};
      if (!command) throw new Error('Missing command');

      const { run } = await import('./lib/process.mjs');
      const workDir = cwd || process.cwd();
      process.stderr.write('[engine] Running command: ' + command + ' ' + (args || []).join(' ') + ' in ' + workDir + '\n');

      result = await run(command, args || [], workDir, {
        timeoutMs: 120000,
        maxOutputBytes: 131072,
        shell: true,
      });

      process.stderr.write('[engine] Command exited with code: ' + result.exitCode + '\n');
      result.success = result.exitCode === 0 && !result.error && !result.timedOut;

    } else if (request.method === 'chat.diagnose') {
      const { command, stdout, stderr } = request.params || {};
      const { provider, model } = selectModelProvider();
      const router = new CapabilityRouter([provider]);
      await router.refreshModels();

      const rawOutput = ((stderr || '') + '\n' + (stdout || '')).replace(/\x1b\[[0-9;]*m/g, '');
      const errorText = rawOutput.slice(-4000);

      const system = 'You are an expert autonomous debugger. A terminal command failed. ' +
        'Analyze the error output and determine the exact steps required to fix it. ' +
        'You MUST output a valid JSON object with an "actions" array detailing the steps to execute. ' +
        'Format: {"actions": [{"type": "run", "command": "npm", "args": ["install", "--save-dev", "ts-jest"]}, {"type": "edit", "filePath": "jest.config.js", "instruction": "add ts-jest"}]}\n' +
        'If the error is a Jest/TypeScript parsing error in a .ts file, and the project is not configured for TS tests, the best fix is to delete the .ts file and recreate it as a .js file with identical logic, OR install ts-jest and configure it. Choose the simplest path.\n' +
        'If a dependency is missing, use a "run" action to install it.\n' +
        'Output ONLY the JSON object. No markdown, no extra text.';

      const user = 'Command: ' + command + '\n\nError Output:\n' + errorText;

      const response = await provider.complete({
        modelId: model || 'qwen/qwen-2.5-72b-instruct', // Upgrade to 72B for better debugging
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: 0.1,
        maxOutputTokens: 512,
      });

      let cleaned = response.content.trim();
      if (cleaned.startsWith('```json')) cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      else if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');

      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        cleaned = cleaned.substring(firstBrace, lastBrace + 1);
      }

      try {
        result = JSON.parse(cleaned);
      } catch (e) {
        result = { actions: [], fallbackInstruction: 'Failed to parse diagnosis: ' + cleaned };
      }

    } else if (request.method === 'chat.edit') {
      const { filePath, instruction, fileContent } = request.params || {};
      if (!filePath || !instruction) throw new Error('Missing filePath or instruction');

      const { provider, model } = selectModelProvider();
      const router = new CapabilityRouter([provider]);
      await router.refreshModels();

      const systemContent = 'You are an expert code-editing AI. You must output ONLY a SEARCH/REPLACE block to modify the given file. ' +
        'Do NOT output any explanations, greetings, or markdown formatting outside the block. ' +
        'Use the exact following format:\n' +
        '<<<<<<< SEARCH\n' +
        '[exact lines to find in the original file]\n' +
        '=======\n' +
        '[new lines to replace them with]\n' +
        '>>>>>>> REPLACE\n' +
        'If you need to add new code, search for the surrounding lines and replace them with those same lines plus the new code.\n' +
        'If the file is empty, use an empty SEARCH block.\n' +
        'Output ONLY the SEARCH/REPLACE block. No other text.';

      const userContent = 'FILE PATH: ' + filePath +
        '\n\nINSTRUCTION: ' + instruction +
        '\n\nCURRENT FILE CONTENT:\n' + (fileContent || '(empty file)') +
        '\n\nOUTPUT THE SEARCH/REPLACE BLOCK NOW:';

      const response = await provider.complete({
        modelId: model || 'qwen2.5:3b',
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: userContent },
        ],
        temperature: 0.1,
        maxOutputTokens: 2048,
      });

      let rawOutput = response.content.trim();
      if (rawOutput.startsWith('```')) {
        rawOutput = rawOutput.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '');
      }

      let editedContent = fileContent || '';
      let appliedCount = 0;

      // PRODUCTION SANITIZATION: Strip accidental wrapping artifacts from LLM output
      const sanitizeOutput = (text) => {
        let cleaned = text.trim();
        // Remove accidental leading/trailing brackets (common LLM mistake)
        if (cleaned.startsWith('[') && !cleaned.includes('module.exports')) {
          cleaned = cleaned.replace(/^\[\s*/, '');
        }
        if (cleaned.endsWith(']') && !cleaned.includes('module.exports')) {
          cleaned = cleaned.replace(/\s*\]$/, '');
        }
        // Remove accidental JSON wrapping
        if (cleaned.startsWith('{') && cleaned.includes('"content"')) {
          try {
            const parsed = JSON.parse(cleaned);
            if (parsed.content) cleaned = parsed.content;
          } catch { /* not JSON, leave as is */ }
        }
        return cleaned;
      };

      const applyPatch = (searchBlock, replaceBlock) => {
        if (editedContent.includes(searchBlock)) {
          editedContent = editedContent.replace(searchBlock, replaceBlock);
          appliedCount++;
          return true;
        }
        const searchLines = searchBlock.split('\n').map((l) => l.trim()).filter((l) => l);
        if (searchLines.length === 0) return false;

        const fileLines = editedContent.split('\n');
        for (let i = 0; i <= fileLines.length - searchLines.length; i++) {
          let matchAll = true;
          for (let j = 0; j < searchLines.length; j++) {
            if (fileLines[i + j].trim() !== searchLines[j]) {
              matchAll = false;
              break;
            }
          }
          if (matchAll) {
            const replaceLines = replaceBlock.split('\n');
            fileLines.splice(i, searchLines.length, ...replaceLines);
            editedContent = fileLines.join('\n');
            appliedCount++;
            return true;
          }
        }
        return false;
      };

      const strictRegex = /<<<<<<< SEARCH\n([\s\S]*?)\n?=======\n([\s\S]*?)\n?>>>>>>> REPLACE/g;
      let match;
      while ((match = strictRegex.exec(rawOutput)) !== null) {
        applyPatch(match[1], match[2]);
      }

      if (appliedCount === 0) {
        process.stderr.write('[engine] Strict format not found. Trying simple SEARCH/REPLACE format...\n');
        const simpleRegex = /SEARCH:\s*\n([\s\S]*?)\nREPLACE:\s*\n([\s\S]*?)(?=\nSEARCH:|$)/gi;
        while ((match = simpleRegex.exec(rawOutput)) !== null) {
          applyPatch(match[1], match[2]);
        }
      }

      if (appliedCount === 0) {
        throw new Error('Failed to apply changes. The model did not output a recognizable SEARCH/REPLACE block. Raw output:\n' + rawOutput.slice(0, 500));
      }

      // NUCLEAR SANITIZATION: Force strip any LLM wrapping artifacts before saving
      let finalContent = editedContent;
      if (typeof finalContent === 'string') {
        finalContent = finalContent.trim();
        // Strip accidental array wrapping: [code]
        if (finalContent.startsWith('[') && finalContent.endsWith(']')) {
          try { JSON.parse(finalContent); } catch {
            finalContent = finalContent.substring(1, finalContent.length - 1).trim();
          }
        }
        // Strip accidental JSON object wrapping: {"content": "code"}
        if (finalContent.startsWith('{') && finalContent.endsWith('}')) {
          try {
            const parsed = JSON.parse(finalContent);
            if (typeof parsed.content === 'string') finalContent = parsed.content;
          } catch {}
        }
        // Strip accidental markdown code blocks that slipped through
        if (finalContent.startsWith('```typescript')) finalContent = finalContent.replace(/^```typescript\n?/, '');
        else if (finalContent.startsWith('```ts')) finalContent = finalContent.replace(/^```ts\n?/, '');
        else if (finalContent.startsWith('```javascript')) finalContent = finalContent.replace(/^```javascript\n?/, '');
        else if (finalContent.startsWith('```js')) finalContent = finalContent.replace(/^```js\n?/, '');
        else if (finalContent.startsWith('```')) finalContent = finalContent.replace(/^```\n?/, '');
        if (finalContent.endsWith('```')) finalContent = finalContent.replace(/\n?```$/, '');

        finalContent = finalContent.trim();
      }

      // AUTO-REPAIR package.json: Strip trailing commas before saving to prevent JSONParseError
      if (filePath.endsWith('package.json') && typeof finalContent === 'string') {
        try {
          JSON.parse(finalContent);
        } catch (e) {
          // Regex to remove trailing commas before } or ]
          let repaired = finalContent.replace(/,\s*([\]}])/g, '$1');
          try {
            JSON.parse(repaired);
            finalContent = repaired;
            process.stderr.write('[engine] Auto-repaired invalid JSON (trailing comma) in package.json\n');
          } catch (e2) {
            process.stderr.write('[engine] CRITICAL: Could not auto-repair package.json: ' + e2.message + '\n');
          }
        }
      }

      result = {
        filePath: filePath,
        originalContent: fileContent || '',
        editedContent: finalContent,
        instruction: instruction,
        modelUsed: model || 'unknown',
      };
    } else if (request.method === 'chat.query') {
      const { message, history, workspaceContext } = request.params || {};
      if (!message) throw new Error('Missing message');

      const { provider, source, model } = selectModelProvider();
      const router = new CapabilityRouter([provider]);
      await router.refreshModels();

      const historyText = history && history.length > 0
        ? history.map((h) => h.role + ': ' + h.content).join('\n')
        : '';

      let frameworkContext = '';
      if (workspaceContext && workspaceContext.includes('Frameworks:')) {
        const frameworksMatch = workspaceContext.match(/Frameworks:\s*([^\n]+)/);
        if (frameworksMatch && frameworksMatch[1]) {
          const frameworks = frameworksMatch[1].split(',').map(f => f.trim());
          const { generateFrameworkContext } = await import('./lib/framework-prompts.mjs');
          frameworkContext = generateFrameworkContext(frameworks);
        }
      }

                  const systemContent = '*** MANDATORY PRE-FLIGHT ENVIRONMENT CHECK ***\n' +
        'Before generating ANY action plan, you MUST analyze the workspace context provided below.\n' +
        'If the user asks to ADD, CREATE, or IMPLEMENT tests, you MUST verify the following in the context:\n' +
        '1. Is the test runner (jest, vitest, pytest) installed in package.json dependencies? If NO, your FIRST action MUST be to install it.\n' +
        '2. Does the "test" script exist in package.json scripts? If NO, your SECOND action MUST be to add it.\n' +
        '3. If the project uses TypeScript (has tsconfig.json or .ts files), is ts-jest installed and configured? If NO, you MUST install ts-jest and create jest.config.js BEFORE creating the test file.\n' +
        'NEVER assume the testing environment is already set up. You must explicitly plan the setup steps if they are missing from the context.\n\n' +
        '*** PROFESSIONAL CODE GENERATION RULES ***\n' +
        '1. SELF-CONTAINED TESTS: If you create a test file that tests local logic, you MUST either include an edit action to create the source file, OR define the functions directly inside the test file. NEVER import a non-existent local file.\n' +
        '2. ANTI-HALLUCINATION: NEVER run "npm install" to fix a "Cannot find module" error for a relative path (starts with "./" or "../"). Relative paths are local files. Create them instead.\n\n' +
        'You are Junub Agent, an autonomous software engineering agent. ' +
        '- CRITICAL RULE FOR TEST SCRIPTS: When adding or editing the "test" script in package.json, you MUST use exactly "test": "jest" (or "vitest", "pytest", etc.). NEVER add "--watch", "--watchAll", or "--watchman" to the test script. Watch modes cause the automated runner to hang and timeout.\n' +

        'CRITICAL RULE: If the user asks you to implement, create, fix, apply, or do something, ' +
        'you MUST NOT just give text instructions. You MUST output a valid JSON object ' +
        'with an "actions" array detailing the exact steps to execute. ' +
        'Format your response EXACTLY like this JSON (no markdown, no extra text):\n' +
        '{\n' +
        '  "actions": [\n' +
        '    {"type": "edit", "filePath": "package.json", "instruction": "Add a test script using jest"},\n' +
        '    {"type": "run", "command": "npm", "args": ["install", "--save-dev", "jest"]},\n' +
        '    {"type": "edit", "filePath": "__tests__/sample.test.js", "instruction": "Create a basic sample test file that passes"},\n' +
        '    {"type": "run", "command": "npm", "args": ["test"]}\n' +
        '  ]\n' +
        '}\n' +
        'IMPORTANT RULES:\n' +
        '- NEVER hallucinate file paths. Use ONLY the files and frameworks listed in the workspace context.\n' +
        '- If the user is just asking a general question and no file edits or commands are needed, respond with normal text.\n' +
        (frameworkContext ? '\n\nFRAMEWORK-SPECIFIC RULES:\n' + frameworkContext : '');

      // DETERMINISTIC PRE-FLIGHT ENVIRONMENT CHECK (Engine-level, not LLM-reliant)
      let preFlightDirectives = '';
      if (workspaceContext && message.toLowerCase().includes('test')) {
        const hasJest = workspaceContext.includes('jest') || workspaceContext.includes('vitest');
        const isTypeScript = workspaceContext.toLowerCase().includes('typescript') || workspaceContext.includes('.ts');
        const hasTestScript = workspaceContext.includes('\"test\"');

        if (!hasJest) {
          preFlightDirectives += '\n\n*** SYSTEM PRE-FLIGHT ALERT ***: The project does NOT have a test runner installed. Your plan MUST include an action to install jest (and ts-jest + @types/jest if it is a TypeScript project).\n';
        }
        if (isTypeScript && !workspaceContext.includes('ts-jest')) {
          preFlightDirectives += '\n*** SYSTEM PRE-FLIGHT ALERT ***: The project uses TypeScript but ts-jest is NOT installed. Your plan MUST include an action to install ts-jest AND create jest.config.js with the ts-jest preset BEFORE creating any .ts test files.\n';
        }
        if (!hasTestScript) {
          preFlightDirectives += '\n*** SYSTEM PRE-FLIGHT ALERT ***: The package.json "test" script is missing. Your plan MUST include an action to add "test": "jest" to the scripts.\n';
        }
      }

      // AGGRESSIVE DETERMINISTIC PRE-FLIGHT CHECK
      let systemDirective = '';
      const lowerMsg = message.toLowerCase();
      if (workspaceContext && (lowerMsg.includes('test') || lowerMsg.includes('testing'))) {
        const isTypeScript = workspaceContext.includes('typescript') || workspaceContext.includes('tsconfig.json');
        const hasTsJest = workspaceContext.includes('ts-jest');
        const hasJestConfig = workspaceContext.includes('jest.config');
        const hasTestScript = /\"test\"\s*:\s*\"jest\"/.test(workspaceContext) || /\"test\"\s*:\s*\"vitest\"/.test(workspaceContext);

        let missing = [];
        if (!workspaceContext.includes('jest') && !workspaceContext.includes('vitest')) {
           missing.push('Run: npm install --save-dev jest');
        }
        if (isTypeScript && !hasTsJest) {
           missing.push('Run: npm install --save-dev ts-jest @types/jest');
        }
        if (isTypeScript && !hasJestConfig) {
           missing.push('Create jest.config.js with: module.exports = { preset: "ts-jest", testEnvironment: "node" };');
        }
        if (!hasTestScript) {
           missing.push('Add "test": "jest" to package.json scripts');
        }

        if (missing.length > 0) {
           systemDirective = '\n\n[SYSTEM DIRECTIVE - MANDATORY COMPLIANCE]\n' +
             'The workspace is missing critical testing infrastructure. Your "actions" array MUST include these setup steps FIRST, before creating any test files:\n' +
             missing.map((m, i) => (i + 1) + '. ' + m).join('\n') +
             '\nDo NOT skip these steps. The environment MUST be fully configured in your plan.';
        }
      }

      const userContent =
        'WORKSPACE CONTEXT:\n' +
        (workspaceContext || 'No workspace open.') +
        '\n\nCONVERSATION HISTORY:\n' +
        (historyText || 'No previous messages.') +
        '\n\nUSER REQUEST:\n' +
        message + systemDirective;

      const response = await provider.complete({
        modelId: model || 'qwen/qwen-2.5-72b-instruct',
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: userContent },
        ],
        temperature: 0.1,
        maxOutputTokens: 2048,
      });

      let responseText = response.content.trim();
      if (responseText.startsWith('```json')) responseText = responseText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      else if (responseText.startsWith('```')) responseText = responseText.replace(/^```\s*/, '').replace(/\s*```$/, '');

      let isActionPlan = false;
      try {
        const firstBrace = responseText.indexOf('{');
        const lastBrace = responseText.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace > firstBrace) {
          const jsonStr = responseText.substring(firstBrace, lastBrace + 1);
          const parsed = JSON.parse(jsonStr);
          if (parsed.actions && Array.isArray(parsed.actions)) {
            // SYSTEM-LEVEL PLAN INJECTION (Auto-inject missing setup steps)
            const hasInstall = parsed.actions.some(a => a.type === 'run' && a.args && a.args.some(arg => arg.includes('jest') || arg.includes('vitest')));
            const hasTsJest = parsed.actions.some(a => a.type === 'run' && a.args && a.args.some(arg => arg.includes('ts-jest')));
            const isTypeScript = workspaceContext && (workspaceContext.toLowerCase().includes('typescript') || workspaceContext.includes('.ts'));
            const hasJestConfig = parsed.actions.some(a => a.type === 'edit' && a.filePath.includes('jest.config'));

            let injectedSteps = [];

            if (isTypeScript && !hasTsJest) {
              injectedSteps.push({ type: 'run', command: 'npm', args: ['install', '--save-dev', 'jest', 'ts-jest', '@types/jest'] });
            } else if (!hasInstall) {
              injectedSteps.push({ type: 'run', command: 'npm', args: ['install', '--save-dev', 'jest'] });
            }

            if (isTypeScript && !hasJestConfig) {
              injectedSteps.push({ type: 'edit', filePath: 'jest.config.js', instruction: 'Create jest config with ts-jest preset' });
            }

            if (injectedSteps.length > 0) {
              parsed.actions = [...injectedSteps, ...parsed.actions];
              process.stderr.write('[engine] Auto-injected ' + injectedSteps.length + ' missing environment setup steps into the plan.\n');
            }

            isActionPlan = true;
            result = { isActionPlan: true, actions: parsed.actions, modelUsed: model || 'unknown' };
          }
        }
      } catch (e) {
        process.stderr.write('[engine] chat.query JSON parse failed, falling back to text: ' + e.message + '\n');
      }

      if (!isActionPlan) {
        result = { isActionPlan: false, response: responseText, modelUsed: model || 'unknown' };
      }
    } else if (request.method === 'task.refine') {
      const { message, history, workspaceContext } = request.params || {};
      if (!message) throw new Error('Missing message for refinement');

      const { provider, source, model } = selectModelProvider();
      const router = new CapabilityRouter([provider]);
      await router.refreshModels();

      const historyText =
        history && history.length > 0
          ? `Previous context:\n${history.map((h) => `${h.role}: ${h.content}`).join('\n')}`
          : 'No previous context.';

      const contextBlock = workspaceContext
        ? `\n\nCURRENT WORKSPACE CONTEXT (Use these exact paths, folders, and technologies. DO NOT hallucinate fake files):\n${workspaceContext}`
        : '';

      const refinePrompt = [
        {
          role: 'system',
          content: `You are an AI agent coordinator. Convert the user's request into a JSON object.
You MUST output ONLY valid JSON. No markdown, no explanations.
${contextBlock}

If the request is clear and actionable, output this EXACT structure:
{
  "contract": {
    "taskId": "chat-1",
    "title": "Short Title",
    "intent": "Clear intent based on context",
    "domain": "software",
    "impact": "low",
    "outputs": [],
    "acceptance": [
      { "id": "a1", "statement": "First measurable criterion using real file names from context" }
    ]
  }
}

If the request is too vague even with context, output this EXACT structure:
{
  "question": "What specific part should I focus on?"
}`,
        },
        { role: 'user', content: `${historyText}\n\nUser request: ${message}` },
      ];

      const response = await provider.complete({
        modelId: model || 'qwen2.5:3b',
        messages: refinePrompt,
        temperature: 0.1,
        maxOutputTokens: 512,
      });

      let cleaned = response.content.trim();
      if (cleaned.startsWith('```json')) {
        cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }

      try {
        result = JSON.parse(cleaned);
        process.stderr.write('[engine] task.refine RAW OUTPUT: ' + cleaned + '\n');
      } catch (err) {
        throw new Error(`Failed to parse refinement JSON: ${err.message}. Raw: ${cleaned.slice(0, 200)}`);
      }
    } else if (request.method === 'task.plan') {
      const contract = request.params?.contract;
      if (!contract || !Array.isArray(contract.acceptance)) {
        throw new Error('Invalid task contract: missing acceptance criteria');
      }
      const { provider, source } = selectModelProvider();
      process.stderr.write('[engine] task.plan using provider: ' + source + '\n');
      const router = new CapabilityRouter([provider]);
      await router.refreshModels();
      result = await generateReadOnlyPlan(contract, { router });

      await logHistory({
        timestamp: new Date().toISOString(),
        taskId: contract.taskId || 'unknown',
        event: 'plan_generated',
        contract: { title: contract.title, intent: contract.intent, domain: contract.domain },
        planStepsCount: result.steps ? result.steps.length : 0,
        modelUsed: result.modelUsed || source,
        plan: result.steps || null,
        refusal: result.reason
          ? { reason: result.reason, message: result.message, suggestedNextAction: result.suggestedNextAction }
          : null,
      });
    } else if (request.method === 'task.compile') {
      const plan = request.params?.plan;
      const context = request.params?.context;
      if (!plan || !context) {
        throw new Error('Missing plan or context for compilation');
      }
      result = compilePlan(plan, context);
    } else if (request.method === 'task.run') {
      const contract = request.params?.contract;
      if (!contract || !Array.isArray(contract.acceptance)) {
        throw new Error('Invalid task contract: missing acceptance criteria');
      }
      const taskId = contract.taskId || 'task-' + Date.now();

      process.stdout.write(
        serializeProtocolMessage({
          protocolVersion: 1,
          requestId: request.requestId,
          success: true,
          result: { taskId, status: 'accepted' },
          timestamp: new Date().toISOString(),
        }) + '\n'
      );

      executeRealTask(taskId, contract, request.params?.plan);
      return;
    } else {
      throw new Error('Unknown method: ' + request.method);
    }
  } catch (err) {
    success = false;
    let errorMessage = err.message || 'Unknown error';

    if (errorMessage.includes('429') || errorMessage.includes('rate-limited') || errorMessage.includes('engine_overloaded')) {
      errorMessage = 'Rate limit reached. The free OpenRouter shared pool is currently overloaded. ' +
        'Please wait a moment and try again, or configure your own OpenRouter API key in VS Code settings (junubAgent.dashscopeApiKey) for dedicated, higher limits.';
    }

    if (errorMessage.includes('fetch failed') || errorMessage.includes('ENOTFOUND') || errorMessage.includes('ECONNREFUSED')) {
      errorMessage = 'Network error. Unable to reach the AI provider. Please check your internet connection or verify that your local Ollama server is running if using local models.';
    }

    errorPayload = { code: err.code || 'UNKNOWN_ERROR', message: errorMessage };
  }

  process.stdout.write(
    serializeProtocolMessage({
      protocolVersion: 1,
      requestId: request.requestId,
      success,
      ...(success ? { result } : { error: errorPayload }),
      timestamp: new Date().toISOString(),
    }) + '\n'
  );
});

process.stderr.write('[engine] Junub Agent headless engine started.\n');
