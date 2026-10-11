import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { EngineTransport } from '../transport.js';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface PendingEdit {
  filePath: string;
  originalContent: string;
  editedContent: string;
  instruction: string;
}

interface PendingCommand {
  command: string;
  args: string[];
  cwd: string;
  description: string;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'junubAgentChat';
  private _view?: vscode.WebviewView;
  private history: ChatMessage[] = [];
  private pendingEdit: PendingEdit | null = null;
  private pendingCommand: PendingCommand | null = null;
  private pendingEditIsAutoFix: boolean = false;
  private pendingFailedCommand: string | null = null;
  private pendingFilmFix: { path: string; timelinePath: string; relinks: any[] } | null = null;
  private pendingActionPlan: any[] | null = null;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly transport: EngineTransport,
    private readonly outputChannel: vscode.OutputChannel
  ) { }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
    webviewView.webview.html = this._getHtmlForWebview();

    webviewView.webview.onDidReceiveMessage(async (data) => {
      if (data.type === 'sendMessage') {
        await this._handleUserMessage(data.text);
      } else if (data.type === 'approveEdit') {
        if (this.pendingFilmFix) {
          await this._applyFilmFix();
        } else {
          await this._applyPendingEdit();
        }
      } else if (data.type === 'rejectEdit') {
        this.pendingEdit = null;
        this.pendingFilmFix = null;
        this.pendingEditIsAutoFix = false;
        this._postMessage({ type: 'result', status: 'rejected', title: 'Edit Rejected', detail: 'No files were modified.' });
      } else if (data.type === 'viewDiff') {
        await this._showDiffPreview();
      } else if (data.type === 'runCommand') {
        await this._executePendingCommand();
      } else if (data.type === 'rejectCommand') {
        this.pendingCommand = null;
        this._postMessage({ type: 'result', status: 'rejected', title: 'Command Cancelled', detail: 'No command was executed.' });
      } else if (data.type === 'autoFix') {
        await this._handleAutoFix(data.command, data.stdout, data.stderr);
      } else if (data.type === 'executePlan') {
        await this._executeActionPlan();
      }
    });
  }

  // -------------------------------------------------------------------------
  // Workspace Context (RAG)
  // -------------------------------------------------------------------------
  private async _readWorkspaceContext(): Promise<string> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) return 'No workspace open.';
    const parts: string[] = [];
    parts.push('Workspace root: ' + workspaceFolder);
    try {
      const entries = await fs.readdir(workspaceFolder, { withFileTypes: true });
      const topLevel = entries
        .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
        .slice(0, 50)
        .map(e => e.isDirectory() ? '  [DIR] ' + e.name + '/' : '  [FILE] ' + e.name)
        .join('\n');
      parts.push('\nTop-level structure:\n' + topLevel);
      try {
        const pkgRaw = await fs.readFile(path.join(workspaceFolder, 'package.json'), 'utf8');
        const pkg = JSON.parse(pkgRaw);
        const deps = Object.keys(pkg.dependencies || {});
        const devDeps = Object.keys(pkg.devDependencies || {});
        parts.push('\npackage.json name: ' + (pkg.name || 'unknown'));
        parts.push('Dependencies: ' + (deps.length > 0 ? deps.join(', ') : 'none'));
        parts.push('DevDependencies: ' + (devDeps.length > 0 ? devDeps.join(', ') : 'none'));
        if (pkg.scripts) parts.push('Scripts: ' + Object.keys(pkg.scripts).join(', '));
      } catch { /* no package.json */ }

      // UNIVERSAL LANGUAGE DETECTION
      try {
        const detection = await this.transport.request('workspace.detectLanguage', { path: workspaceFolder }) as any;
        if (detection.languages && detection.languages.length > 0) {
          parts.push('\n=== PROJECT TECHNOLOGY STACK ===');
          if (detection.languages.length > 0) parts.push('Programming Languages: ' + detection.languages.join(', '));
          if (detection.frameworks && detection.frameworks.length > 0) parts.push('Frameworks: ' + detection.frameworks.join(', '));
          if (detection.libraries && detection.libraries.length > 0) parts.push('Key Libraries: ' + detection.libraries.join(', '));
          if (detection.buildTools && detection.buildTools.length > 0) parts.push('Build Tools: ' + detection.buildTools.join(', '));
          if (detection.packageManagers && detection.packageManagers.length > 0) parts.push('Package Managers: ' + detection.packageManagers.join(', '));
          if (detection.testFrameworks && detection.testFrameworks.length > 0) parts.push('Test Frameworks: ' + detection.testFrameworks.join(', '));
          if (detection.databases && detection.databases.length > 0) parts.push('Databases: ' + detection.databases.join(', '));
          if (detection.cssFrameworks && detection.cssFrameworks.length > 0) parts.push('CSS Frameworks: ' + detection.cssFrameworks.join(', '));
          if (detection.mobile && detection.mobile.length > 0) parts.push('Mobile Platforms: ' + detection.mobile.join(', '));
          if (detection.devOps && detection.devOps.length > 0) parts.push('DevOps/Infrastructure: ' + detection.devOps.join(', '));
          if (detection.entryPoints && detection.entryPoints.length > 0) parts.push('Entry Points: ' + detection.entryPoints.join(', '));
          parts.push('Primary Ecosystem: ' + (detection.primaryEcosystem || 'unknown'));
          parts.push('Detection Confidence: ' + (detection.confidence || 'unknown'));
          parts.push('================================\n');
        }
      } catch { /* detection failed silently */ }

      try {
        const srcTree = await this._listDir(path.join(workspaceFolder, 'src'), '', 2);
        if (srcTree) parts.push('\nsrc/ structure:\n' + srcTree);
      } catch { /* no src dir */ }
      try {
        const pkgTree = await this._listDir(path.join(workspaceFolder, 'packages'), '', 2);
        if (pkgTree) parts.push('\npackages/ structure:\n' + pkgTree);
      } catch { /* no packages dir */ }
      try {
        const appTree = await this._listDir(path.join(workspaceFolder, 'apps'), '', 2);
        if (appTree) parts.push('\napps/ structure:\n' + appTree);
      } catch { /* no apps dir */ }
    } catch (e: any) {
      parts.push('Error reading workspace: ' + e.message);
    }
    return parts.join('\n');
  }

  private async _listDir(dirPath: string, indent: string, maxDepth: number): Promise<string> {
    if (maxDepth <= 0) return '';
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const lines: string[] = [];
      const filtered = entries
        .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist')
        .slice(0, 30);
      for (const entry of filtered) {
        if (entry.isDirectory()) {
          lines.push(indent + '  [DIR] ' + entry.name + '/');
          const sub = await this._listDir(path.join(dirPath, entry.name), indent + '  ', maxDepth - 1);
          if (sub) lines.push(sub);
        } else {
          lines.push(indent + '  [FILE] ' + entry.name);
        }
      }
      return lines.join('\n');
    } catch { return ''; }
  }

  // -------------------------------------------------------------------------
  // Intent Parsing (Universal Command Routing)
  // -------------------------------------------------------------------------
  private async _parseCommandRequest(message: string): Promise<{ command: string; args: string[]; description: string } | null> {
    const lower = message.toLowerCase();
    if (!lower.startsWith('run ') && !lower.startsWith('execute ') && !lower.startsWith('start ')) {
      return null;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) {
      const cmdStr = message.replace(/^(run|execute|start)\s+/i, '').trim();
      const parts = cmdStr.split(/\s+/).filter(p => p.length > 0);
      if (parts.length === 0) return null;
      return { command: parts[0]!, args: parts.slice(1), description: 'Run: ' + cmdStr };
    }

    try {
      const resolved = await this.transport.request('workspace.resolveCommand', {
        intent: message,
        workspacePath: workspaceFolder
      }) as any;

      if (resolved && resolved.success) {
        return {
          command: resolved.command,
          args: resolved.args,
          description: resolved.description,
        };
      }
    } catch (e) {
      this.outputChannel.appendLine('[Chat] Command resolution failed: ' + (e as Error).message);
    }

    const cmdStr = message.replace(/^(run|execute|start)\s+/i, '').trim();
    const parts = cmdStr.split(/\s+/).filter(p => p.length > 0);
    if (parts.length === 0) return null;
    return { command: parts[0]!, args: parts.slice(1), description: 'Run generic command: ' + cmdStr };
  }

  private _parseEditRequest(message: string): { filePath: string; instruction: string } | null {
    const editPatterns = [
      /(?:edit|modify|update|change|refactor|add to|create)\s+([^\s]+\.\w+)\s+(?:to|:|with|by)\s+(.+)/i,
      /(?:edit|modify|update|change|refactor)\s+(?:the\s+)?file\s+([^\s]+\.\w+)\s+(?:to|:|with|by)\s+(.+)/i,
    ];
    for (const pattern of editPatterns) {
      const match = message.match(pattern);
      if (match && match[1] && match[2]) {
        return { filePath: match[1].trim(), instruction: match[2].trim() };
      }
    }
    return null;
  }

  private _parseDomainRequest(message: string): { domain: string; action: string; path: string } | null {
    const lower = message.toLowerCase();

    if (lower.includes('inspect film') || lower.includes('check media') || lower.includes('verify timeline')) {
      return { domain: 'film', action: 'inspect', path: '.' };
    }
    if (lower.includes('fix film') || lower.includes('fix media') || lower.includes('relink media') || lower.includes('fix timeline')) {
      return { domain: 'film', action: 'fix', path: '.' };
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // Main Message Handler
  // -------------------------------------------------------------------------
  private async _handleUserMessage(message: string) {
    this.outputChannel.appendLine('[Chat] User: ' + message);
    this.history.push({ role: 'user', content: message });

    const cmdRequest = await this._parseCommandRequest(message);
    if (cmdRequest) { await this._handleCommandRequest(cmdRequest); return; }

    const editRequest = this._parseEditRequest(message);
    if (editRequest) { await this._handleEditRequest(editRequest.filePath, editRequest.instruction); return; }

    const domainRequest = this._parseDomainRequest(message);
    if (domainRequest) {
      await this._handleDomainRequest(domainRequest);
      return;
    }

    this._postMessage({ type: 'status', text: 'Reading workspace context...' });
    try {
      const workspaceContext = await this._readWorkspaceContext();
      this._postMessage({ type: 'status', text: 'Analyzing request and planning actions...' });

      const result = await this.transport.request('chat.query', {
        message, history: this.history.slice(-6), workspaceContext,
      }) as any;

      if (result.error) {
        this._postMessage({ type: 'result', status: 'error', title: 'Query Failed', detail: result.error.message });
        return;
      }

      // AUTONOMOUS ACTION PLAN EXECUTION
      if (result.isActionPlan && result.actions && result.actions.length > 0) {
        this.pendingActionPlan = result.actions;
        let executionLog = result.actions.map((a: any, i: number) =>
          `Step ${i + 1}: ${a.type === 'edit' ? 'Edit ' + a.filePath : 'Run ' + a.command + ' ' + (a.args || []).join(' ')}`
        );

        this.history.push({ role: 'assistant', content: 'Generated autonomous action plan.' });
        this._postMessage({
          type: 'plan',
          steps: executionLog,
        });
        return;
      }

      // NORMAL TEXT RESPONSE
      const responseText = result.response || 'No response received.';
      this.history.push({ role: 'assistant', content: responseText });
      this._postMessage({ type: 'response', text: this._formatMarkdown(responseText) });

    } catch (error: any) {
      this._postMessage({ type: 'result', status: 'error', title: 'Query Failed', detail: error.message || String(error) });
    }
  }

  // -------------------------------------------------------------------------
  // Domain Execution Handler
  // -------------------------------------------------------------------------
  private async _handleDomainRequest(req: { domain: string; action: string; path: string }) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '.';
    const targetPath = path.isAbsolute(req.path) ? req.path : path.join(workspaceFolder, req.path);

    if (req.domain === 'film') {
      if (req.action === 'inspect') {
        this._postMessage({ type: 'status', text: 'Inspecting Film Project & Verifying Media Links...' });
        try {
          const report = await this.transport.request('pack.film.inspect', { path: targetPath }) as any;
          this.outputChannel.appendLine('[Chat] Film inspect raw report: ' + JSON.stringify(report, null, 2));

          let detail = 'Project: ' + (report.root || targetPath) + '\n';
          const clips = report.clips || [];
          detail += 'Total Clips: ' + clips.length + '\n';

          const missing = clips.filter((c: any) => !c.mediaExists);
          const linked = clips.filter((c: any) => c.mediaExists);

          detail += '\n--- Media Status ---\n';
          detail += 'Linked: ' + linked.length + '\n';
          detail += 'Missing: ' + missing.length + '\n';

          if (missing.length > 0) {
            detail += '\nMissing Files:\n';
            missing.forEach((c: any) => { detail += '- ' + c.clipName + ' -> ' + c.mediaPath + '\n'; });
          } else if (clips.length > 0) {
            detail += '\nVerified Files:\n';
            clips.slice(0, 10).forEach((c: any) => { detail += '- ' + c.clipName + ' (' + c.source + ')\n'; });
            if (clips.length > 10) detail += '... and ' + (clips.length - 10) + ' more.\n';
          }

          this._postMessage({
            type: 'result',
            status: missing.length > 0 ? 'failure' : 'success',
            title: missing.length > 0 ? 'Film Inspection: Missing Media' : 'Film Inspection: All Media Linked',
            detail: detail,
          });
        } catch (e: any) {
          this._postMessage({ type: 'result', status: 'error', title: 'Film Inspection Failed', detail: e.message });
        }
      } else if (req.action === 'fix') {
        this._postMessage({ type: 'status', text: 'Diagnosing missing media and generating relink patch...' });
        try {
          const diagnosis = await this.transport.request('pack.film.fix', { path: targetPath }) as any;
          this.outputChannel.appendLine('[Chat] Film fix diagnosis: ' + JSON.stringify(diagnosis, null, 2));

          if (!diagnosis.missingClips || diagnosis.missingClips.length === 0) {
            this._postMessage({
              type: 'result',
              status: 'success',
              title: 'Film Fix: No Missing Media',
              detail: 'All media references in the timeline are already linked. No fix needed.',
            });
            return;
          }

          let detail = 'Missing Media Detected:\n\n';
          diagnosis.proposedRelsinks.forEach((r: any) => {
            detail += '  Missing: ' + r.missingFile + '\n';
            detail += '  Relink to: ' + r.availableFile + '\n\n';
          });

          detail += 'This will update the EDL timeline file to point to available media.\n';
          detail += 'Timeline: ' + diagnosis.timelinePath + '\n';

          this.pendingFilmFix = {
            path: targetPath,
            timelinePath: diagnosis.timelinePath,
            relinks: diagnosis.proposedRelsinks,
          };

          this._postMessage({
            type: 'edit',
            filePath: diagnosis.timelinePath,
            instruction: 'Relink ' + diagnosis.proposedRelsinks.length + ' missing media files to available assets',
            changes: diagnosis.proposedRelsinks.length + ' media references will be updated',
          });

        } catch (e: any) {
          this._postMessage({ type: 'result', status: 'error', title: 'Film Fix Failed', detail: e.message || String(e) });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Command Execution Flow
  // -------------------------------------------------------------------------
  private async _handleCommandRequest(cmd: { command: string; args: string[]; description: string }) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '.';
    this.pendingCommand = { command: cmd.command, args: cmd.args, cwd: workspaceFolder, description: cmd.description };
    this._postMessage({
      type: 'command',
      command: cmd.command + ' ' + cmd.args.join(' '),
      description: cmd.description,
      cwd: workspaceFolder,
    });
  }

  private async _executePendingCommand() {
    if (!this.pendingCommand) {
      this._postMessage({ type: 'result', status: 'error', title: 'No Pending Command', detail: 'No command is waiting to be executed.' });
      return;
    }

    const cmd = this.pendingCommand;
    this._postMessage({ type: 'status', text: 'Executing: ' + cmd.command + ' ' + cmd.args.join(' ') + '...' });

    try {
      const result = await this.transport.request('chat.run', {
        command: cmd.command, args: cmd.args, cwd: cmd.cwd,
      }) as any;

      if (result.error && !result.stdout && !result.stderr) {
        this._postMessage({ type: 'result', status: 'error', title: 'Execution Failed', detail: 'Failed to start: ' + result.error });
        return;
      }

      const success = result.success || result.exitCode === 0;
      const durationSec = (result.durationMs / 1000).toFixed(1);

      let detail = 'Command: ' + cmd.command + ' ' + cmd.args.join(' ') + '\n';
      detail += 'Exit code: ' + result.exitCode + '\n';
      detail += 'Duration: ' + durationSec + 's\n';
      if (result.timedOut) detail += 'WARNING: Command timed out.\n';
      if (result.truncated) detail += 'NOTE: Output was truncated.\n';
      if (result.stdout && result.stdout.trim()) detail += '\n--- stdout ---\n' + result.stdout.trim();
      if (result.stderr && result.stderr.trim()) detail += '\n--- stderr ---\n' + result.stderr.trim();

      this.history.push({
        role: 'assistant',
        content: 'Executed "' + cmd.command + ' ' + cmd.args.join(' ') + '" — ' + (success ? 'Succeeded' : 'Failed') + ' (exit ' + result.exitCode + ', ' + durationSec + 's)',
      });

      this._postMessage({
        type: 'result',
        status: success ? 'success' : 'failure',
        title: success ? 'Command Succeeded' : 'Command Failed',
        detail: detail,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        command: cmd.command + ' ' + cmd.args.join(' ')
      });
      this.pendingCommand = null;

      if (!success && result.stderr) {
        this._postMessage({ type: 'status', text: 'Build failed. Automatically diagnosing and fixing...' });
        await new Promise(resolve => setTimeout(resolve, 1000));
        this._handleAutoFix(cmd.command + ' ' + cmd.args.join(' '), result.stdout || '', result.stderr || '');
      }

    } catch (error: any) {
      this._postMessage({ type: 'result', status: 'error', title: 'Execution Error', detail: error.message || String(error) });
    }
  }

  // -------------------------------------------------------------------------
  // Auto-Fix Flow (The Agentic Loop)
  // -------------------------------------------------------------------------
  private async _handleAutoFix(command: string, stdout: string, stderr: string) {
    this._postMessage({ type: 'status', text: 'Analyzing error to generate a multi-step fix...' });
    try {
      const diag = await this.transport.request('chat.diagnose', { command, stdout, stderr }) as any;

      if (diag.actions && Array.isArray(diag.actions) && diag.actions.length > 0) {
        this._postMessage({ type: 'status', text: `Executing ${diag.actions.length} auto-fix steps...` });
        for (const action of diag.actions) {
          if (action.type === 'edit') {
            await this._autoApplyEdit(action.filePath, action.instruction);
          } else if (action.type === 'run') {
            await this._autoRunCommand(action.command, action.args || []);
          }
        }
        // After applying all fix steps, re-run the original failed command to verify
        this._postMessage({ type: 'status', text: 'Verifying auto-fix by re-running the failed command...' });
        const cmdParts = command.split(' ');
        if (cmdParts.length > 0 && cmdParts[0]) {
          await this._autoRunCommand(cmdParts[0], cmdParts.slice(1));
        }
        return;
      }

      // Fallback to old single-file edit if the LLM didn't output actions
      if (!diag.filePath) {
        this._postMessage({ type: 'result', status: 'error', title: 'Cannot Auto-Fix', detail: diag.fallbackInstruction || diag.instruction || 'Could not identify a specific file to fix.' });
        return;
      }

      this._postMessage({ type: 'status', text: 'Found issue in ' + diag.filePath + '. Generating fix...' });
      await this._handleEditRequest(diag.filePath, diag.instruction, true, command);

    } catch (e: any) {
      this._postMessage({ type: 'result', status: 'error', title: 'Auto-Fix Failed', detail: e.message || String(e) });
    }
  }

  // -------------------------------------------------------------------------
  // File Edit Flow
  // -------------------------------------------------------------------------
  private async _handleEditRequest(filePath: string, instruction: string, isAutoFix: boolean = false, failedCmd: string | null = null) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) {
      this._postMessage({ type: 'result', status: 'error', title: 'No Workspace', detail: 'No workspace is currently open.' });
      return;
    }
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceFolder, filePath);

    this._postMessage({ type: 'status', text: 'Reading ' + filePath + '...' });
    let fileContent = '';
    try {
      fileContent = await fs.readFile(fullPath, 'utf8');
    } catch {
      this._postMessage({ type: 'result', status: 'error', title: 'File Not Found', detail: 'Could not find: ' + filePath });
      return;
    }

    this._postMessage({ type: 'status', text: 'Generating edit for ' + filePath + '...' });
    try {
      const result = await this.transport.request('chat.edit', { filePath, instruction, fileContent }) as any;
      if (result.error) {
        this._postMessage({ type: 'result', status: 'error', title: 'Edit Generation Failed', detail: result.error.message });
        return;
      }
      this.pendingEdit = {
        filePath: fullPath,
        originalContent: result.originalContent,
        editedContent: result.editedContent,
        instruction: result.instruction,
      };

      this.pendingEditIsAutoFix = isAutoFix;
      this.pendingFailedCommand = failedCmd;

      const lineDiff = this._countChangedLines(result.originalContent, result.editedContent);
      this._postMessage({ type: 'edit', filePath: filePath, instruction: instruction, changes: lineDiff });
    } catch (error: any) {
      this._postMessage({ type: 'result', status: 'error', title: 'Edit Failed', detail: error.message || String(error) });
    }
  }

  private async _executeActionPlan() {
    if (!this.pendingActionPlan) return;
    const actions = this.pendingActionPlan;
    this.pendingActionPlan = null;

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      if (action.type === 'edit') {
        this._postMessage({ type: 'status', text: `Step ${i + 1}/${actions.length}: Auto-editing ${action.filePath}...` });
        await this._autoApplyEdit(action.filePath, action.instruction);
      } else if (action.type === 'run') {
        this._postMessage({ type: 'status', text: `Step ${i + 1}/${actions.length}: Auto-running ${action.command}...` });
        await this._autoRunCommand(action.command, action.args || []);
      }
    }
    this._postMessage({ type: 'status', text: 'Autonomous plan execution complete.' });
  }

  private async _autoApplyEdit(filePath: string, instruction: string) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) return;
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceFolder, filePath);

    try {
      // Ensure the parent directory exists before attempting to read or write
      await fs.mkdir(path.dirname(fullPath), { recursive: true });

      let fileContent = '';
      try { fileContent = await fs.readFile(fullPath, 'utf8'); } catch { /* empty file */ }

      const result = await this.transport.request('chat.edit', { filePath: fullPath, instruction, fileContent }) as any;
      if (result.error) throw new Error(result.error.message);

      const backupPath = fullPath + '.bak';
      await fs.writeFile(backupPath, fileContent, 'utf8');
      await fs.writeFile(fullPath, result.editedContent, 'utf8');

      this._postMessage({ type: 'response', text: this._formatMarkdown(`**Auto-Edit Applied:** \`${filePath}\``) });
    } catch (e: any) {
      this._postMessage({ type: 'result', status: 'error', title: 'Auto-Edit Failed', detail: e.message });
    }
  }

  private async _autoRunCommand(command: string, args: string[]) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '.';
    try {
      const result = await this.transport.request('chat.run', { command, args, cwd: workspaceFolder }) as any;
      let success = result.exitCode === 0 && !result.timedOut;

      // SPECIAL HANDLING: If a test command times out due to watch mode (--watchAll),
      // analyze the output to determine if tests actually passed.
      if (result.timedOut) {
        const output = ((result.stdout || '') + (result.stderr || '')).replace(/\x1b\[[0-9;]*m/g, '');
        const hasPass = output.includes('PASS ') || /Tests:\s+\d+ passed/.test(output);
        const hasFail = output.includes('FAIL ') || /failed/.test(output);
        // Only count as success if there are passes AND zero failures
        if (hasPass && !hasFail && output.includes('Test Suites:')) {
          success = true;
        }
      }

      let detail = `Command: ${command} ${args.join(' ')}\nExit code: ${result.exitCode}\n`;
      if (result.stdout) detail += `\n--- stdout ---\n${result.stdout.trim().slice(-1000)}`;
      if (result.stderr) detail += `\n--- stderr ---\n${result.stderr.trim().slice(-1000)}`;

      this._postMessage({
        type: 'result',
        status: success ? 'success' : 'failure',
        title: success ? 'Auto-Command Succeeded' : 'Auto-Command Failed',
        detail,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        exitCode: result.exitCode,
        command: `${command} ${args.join(' ')}`
      });
    } catch (e: any) {
      this._postMessage({ type: 'result', status: 'error', title: 'Auto-Command Error', detail: e.message });
    }
  }

  private async _applyFilmFix() {
    if (!this.pendingFilmFix) return;

    this._postMessage({ type: 'status', text: 'Applying EDL relink patch...' });
    try {
      const result = await this.transport.request('pack.film.applyFix', {
        path: this.pendingFilmFix.path,
        timelinePath: this.pendingFilmFix.timelinePath,
        relinks: this.pendingFilmFix.relinks,
      }) as any;

      this.outputChannel.appendLine('[Chat] Film fix result: ' + JSON.stringify(result, null, 2));

      if (result.success) {
        this._postMessage({
          type: 'result',
          status: 'success',
          title: 'Film Fix Applied and Verified',
          detail: 'Successfully relinked ' + result.fixedCount + ' media files.\n' +
            'Timeline: ' + this.pendingFilmFix.timelinePath + '\n' +
            'All media references are now linked.',
        });
        this.history.push({ role: 'assistant', content: 'Fixed ' + result.fixedCount + ' missing media links in ' + this.pendingFilmFix.timelinePath });
      } else {
        this._postMessage({
          type: 'result',
          status: 'failure',
          title: 'Film Fix Failed Verification',
          detail: 'The EDL patch was applied but verification failed.\n' + result.error,
        });
      }
      this.pendingFilmFix = null;
    } catch (e: any) {
      this._postMessage({ type: 'result', status: 'error', title: 'Film Fix Error', detail: e.message || String(e) });
      this.pendingFilmFix = null;
    }
  }

  private _countChangedLines(original: string, edited: string): string {
    const origLines = original.split('\n');
    const editLines = edited.split('\n');
    let added = 0, removed = 0;
    const maxLen = Math.max(origLines.length, editLines.length);
    for (let i = 0; i < maxLen; i++) {
      if (origLines[i] !== editLines[i]) { added++; removed++; }
    }
    return '+' + added + ' added, -' + removed + ' removed';
  }

  private async _showDiffPreview() {
    if (!this.pendingEdit) return;
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const relativePath = workspaceFolder ? path.relative(workspaceFolder, this.pendingEdit.filePath) : this.pendingEdit.filePath;
    const tmpDir = os.tmpdir();
    const origTmp = path.join(tmpDir, 'junub-original-' + Date.now() + path.extname(this.pendingEdit.filePath));
    const editTmp = path.join(tmpDir, 'junub-edited-' + Date.now() + path.extname(this.pendingEdit.filePath));
    await fs.writeFile(origTmp, this.pendingEdit.originalContent, 'utf8');
    await fs.writeFile(editTmp, this.pendingEdit.editedContent, 'utf8');
    await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(origTmp), vscode.Uri.file(editTmp), 'Junub Agent: ' + relativePath);
  }

  private async _applyPendingEdit() {
    if (!this.pendingEdit) return;
    const isAutoFix = this.pendingEditIsAutoFix;

    try {
      const backupPath = this.pendingEdit.filePath + '.bak';
      await fs.writeFile(backupPath, this.pendingEdit.originalContent, 'utf8');
      await fs.writeFile(this.pendingEdit.filePath, this.pendingEdit.editedContent, 'utf8');

      const relativePath = vscode.workspace.workspaceFolders?.[0]
        ? path.relative(vscode.workspace.workspaceFolders[0].uri.fsPath, this.pendingEdit.filePath)
        : this.pendingEdit.filePath;

      this.history.push({ role: 'assistant', content: 'Edited ' + relativePath + ': ' + this.pendingEdit.instruction });
      this._postMessage({
        type: 'result',
        status: 'success',
        title: 'File Saved Successfully',
        detail: 'File: ' + relativePath + '\nInstruction: ' + this.pendingEdit.instruction + '\nBackup: ' + path.basename(backupPath),
      });

      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(this.pendingEdit.filePath));
      await vscode.window.showTextDocument(doc);

      if (isAutoFix) {
        this._postMessage({ type: 'status', text: 'Verifying AI fix by re-running build...' });

        // Re-run the exact command that failed, or fallback to build
        const cmdToRun = this.pendingFailedCommand || 'npm run build';
        const cmdParts = cmdToRun.split(' ');
        const verifyResult = await this.transport.request('chat.run', {
          command: cmdParts[0],
          args: cmdParts.slice(1),
          cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '.',
        }) as any;

        if (verifyResult.exitCode !== 0) {
          this._postMessage({ type: 'status', text: 'AI fix failed verification. Reverting to backup...' });
          await fs.writeFile(this.pendingEdit.filePath, this.pendingEdit.originalContent, 'utf8');

          this._postMessage({
            type: 'result',
            status: 'error',
            title: 'AI Fix Reverted',
            detail: 'The AI attempted a fix, but the build still failed (exit code ' + verifyResult.exitCode + '). Your file has been safely restored from the .bak backup to prevent code corruption.'
          });
        } else {
          this._postMessage({
            type: 'result',
            status: 'success',
            title: 'AI Fix Verified!',
            detail: 'The AI successfully fixed the error and the build now passes.'
          });
        }
      }

      this.pendingEdit = null;
      this.pendingEditIsAutoFix = false;
      this.pendingFailedCommand = null;

    } catch (error: any) {
      this._postMessage({ type: 'result', status: 'error', title: 'Save Failed', detail: error.message || String(error) });
    }
  }

  // -------------------------------------------------------------------------
  // Formatting Helpers
  // -------------------------------------------------------------------------
  private _formatMarkdown(text: string): string {
    let html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _l, code) => '<pre class="code-block">' + code.trim() + '</pre>');
    html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>');
    html = html.replace(/\n\n/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');
    return '<p>' + html + '</p>';
  }

  private _postMessage(message: any) {
    if (this._view) this._view.webview.postMessage(message);
  }

  // -------------------------------------------------------------------------
  // Webview HTML & UI Logic
  // -------------------------------------------------------------------------
  private _getHtmlForWebview() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Junub Agent Chat</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codicon/0.0.36/codicon.css">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--vscode-font-family); padding: 10px; display: flex; flex-direction: column; height: 100vh; color: var(--vscode-foreground); font-size: 13px; }
    #chat-container { flex: 1; overflow-y: auto; padding: 8px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin-bottom: 8px; background: var(--vscode-editor-background); }
    .msg { margin-bottom: 10px; padding: 10px 12px; border-radius: 6px; line-height: 1.5; }
    .msg-user { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); text-align: right; border-radius: 6px 6px 2px 6px; }
    .msg-assistant { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px 6px 6px 2px; }
    .status-bar { display: flex; align-items: center; gap: 8px; padding: 6px 12px; margin-bottom: 10px; color: var(--vscode-descriptionForeground); font-style: italic; border-radius: 4px; background: var(--vscode-editorWidget-background); border: 1px dashed var(--vscode-panel-border); }
    .status-bar .codicon { animation: spin 1s linear infinite; }
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .result-card { margin-bottom: 10px; padding: 12px; border-radius: 6px; border-left: 4px solid; }
    .result-success { border-left-color: var(--vscode-testing-iconPassed); background: var(--vscode-editorWidget-background); }
    .result-failure { border-left-color: var(--vscode-testing-iconFailed); background: var(--vscode-editorWidget-background); }
    .result-error { border-left-color: var(--vscode-errorForeground); background: var(--vscode-editorWidget-background); }
    .result-rejected { border-left-color: var(--vscode-descriptionForeground); background: var(--vscode-editorWidget-background); }
    .result-title { font-weight: bold; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
    .result-detail { white-space: pre-wrap; font-family: var(--vscode-editor-font-family); font-size: 12px; background: var(--vscode-textBlockQuote-background); padding: 8px; border-radius: 4px; margin-top: 6px; max-height: 300px; overflow-y: auto; }
    .action-card { margin-bottom: 10px; padding: 12px; border-radius: 6px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-textLink-foreground); }
    .action-card h4 { margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
    .action-card p { margin: 4px 0; }
    .action-card code { background: var(--vscode-textBlockQuote-background); padding: 1px 5px; border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: 12px; }
    .action-bar { margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap; }
    .action-bar button { padding: 6px 14px; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 6px; font-weight: bold; }
    .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
    .btn-success { background: var(--vscode-testing-iconPassed); color: white; }
    .btn-danger { background: var(--vscode-testing-iconFailed); color: white; }
    .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .code-block { background: var(--vscode-textBlockQuote-background); padding: 10px; border-radius: 4px; font-family: var(--vscode-editor-font-family); font-size: 12px; white-space: pre-wrap; word-wrap: break-word; border-left: 3px solid var(--vscode-textLink-foreground); margin: 6px 0; overflow-x: auto; max-height: 300px; overflow-y: auto; }
    .inline-code { background: var(--vscode-textBlockQuote-background); padding: 1px 5px; border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: 12px; }
    #input-area { display: flex; gap: 8px; }
    #message-input { flex: 1; padding: 8px 10px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 4px; font-family: var(--vscode-font-family); font-size: 13px; }
    #send-btn { padding: 8px 16px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 6px; font-weight: bold; }
    #send-btn:hover { background: var(--vscode-button-hoverBackground); }
    .codicon { font-size: 14px; }
  </style>
</head>
<body>
  <div id="chat-container"></div>
  <div id="input-area">
    <input type="text" id="message-input" placeholder="Ask, edit files, or run commands..." />
    <button id="send-btn"><span class="codicon codicon-send"></span> Send</button>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const chatContainer = document.getElementById('chat-container');
    const messageInput = document.getElementById('message-input');
    const sendBtn = document.getElementById('send-btn');
    let statusBar = null;
    let lastFailedOutput = null;

    function addUserMessage(text) {
      const div = document.createElement('div');
      div.className = 'msg msg-user';
      div.textContent = text;
      chatContainer.appendChild(div);
      scrollToBottom();
    }

    function addAssistantMessage(html) {
      removeStatus();
      const div = document.createElement('div');
      div.className = 'msg msg-assistant';
      div.innerHTML = html;
      chatContainer.appendChild(div);
      scrollToBottom();
    }

    function setStatus(text) {
      removeStatus();
      statusBar = document.createElement('div');
      statusBar.className = 'status-bar';
      statusBar.innerHTML = '<span class="codicon codicon-sync"></span> ' + text;
      chatContainer.appendChild(statusBar);
      scrollToBottom();
    }

    function removeStatus() {
      if (statusBar) { statusBar.remove(); statusBar = null; }
    }

    function addResultCard(status, title, detail, stdout, stderr, exitCode, durationMs, command) {
      removeStatus();
      const iconMap = { success: 'pass', failure: 'error', error: 'error', rejected: 'close' };
      const colorMap = { success: 'var(--vscode-testing-iconPassed)', failure: 'var(--vscode-testing-iconFailed)', error: 'var(--vscode-errorForeground)', rejected: 'var(--vscode-descriptionForeground)' };
      const icon = iconMap[status] || 'info';
      const color = colorMap[status] || 'inherit';

      const div = document.createElement('div');
      div.className = 'result-card result-' + status;
      let html = '<div class="result-title"><span class="codicon codicon-' + icon + '" style="color:' + color + '"></span> ' + title + '</div>';
      if (detail) html += '<div class="result-detail">' + escapeHtml(detail) + '</div>';

      if (status === 'failure' && command) {
        lastFailedOutput = { command: command, stdout: stdout, stderr: stderr };
        html += '<div class="action-bar"><button class="btn-primary" onclick="autoFix()"><span class="codicon codicon-bug"></span> Auto-Fix Error</button></div>';
      }

      div.innerHTML = html;
      chatContainer.appendChild(div);
      scrollToBottom();
    }

    function addCommandCard(command, description, cwd) {
      removeStatus();
      const div = document.createElement('div');
      div.className = 'action-card';
      div.innerHTML =
        '<h4><span class="codicon codicon-terminal"></span> Command Ready</h4>' +
        '<p><strong>Command:</strong> <code>' + escapeHtml(command) + '</code></p>' +
        '<p><strong>Description:</strong> ' + escapeHtml(description) + '</p>' +
        '<p><strong>Working dir:</strong> <code>' + escapeHtml(cwd) + '</code></p>' +
        '<div class="action-bar">' +
          '<button class="btn-primary" onclick="runCommand()"><span class="codicon codicon-play"></span> Run Command</button>' +
          '<button class="btn-danger" onclick="rejectCommand()"><span class="codicon codicon-close"></span> Cancel</button>' +
        '</div>';
      chatContainer.appendChild(div);
      scrollToBottom();
    }

    function addEditCard(filePath, instruction, changes) {
      removeStatus();
      const div = document.createElement('div');
      div.className = 'action-card';
      div.innerHTML =
        '<h4><span class="codicon codicon-diff"></span> Proposed Edit</h4>' +
        '<p><strong>File:</strong> <code>' + escapeHtml(filePath) + '</code></p>' +
        '<p><strong>Instruction:</strong> ' + escapeHtml(instruction) + '</p>' +
        '<p><strong>Changes:</strong> ' + escapeHtml(changes) + '</p>' +
        '<div class="action-bar">' +
          '<button class="btn-secondary" onclick="viewDiff()"><span class="codicon codicon-diff"></span> Preview Diff</button>' +
          '<button class="btn-success" onclick="approveEdit()"><span class="codicon codicon-check"></span> Approve & Save</button>' +
          '<button class="btn-danger" onclick="rejectEdit()"><span class="codicon codicon-close"></span> Reject</button>' +
        '</div>';
      chatContainer.appendChild(div);
      scrollToBottom();
    }

    function addPlanCard(steps) {
      removeStatus();
      const div = document.createElement('div');
      div.className = 'action-card';
      div.innerHTML =
        '<h4><span class="codicon codicon-rocket"></span> Autonomous Plan Ready</h4>' +
        '<p>I have planned ' + steps.length + ' steps to implement your request:</p>' +
        '<ul style="margin: 8px 0 8px 20px; line-height: 1.6;">' + steps.map(s => '<li>' + escapeHtml(s) + '</li>').join('') + '</ul>' +
        '<div class="action-bar">' +
          '<button class="btn-success" onclick="executePlan()"><span class="codicon codicon-play"></span> Execute Entire Plan</button>' +
        '</div>';
      chatContainer.appendChild(div);
      scrollToBottom();
    }

    function escapeHtml(text) {
      if (!text) return '';
      return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function scrollToBottom() {
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    function runCommand() { vscode.postMessage({ type: 'runCommand' }); removeLastActionBar(); }
    function rejectCommand() { vscode.postMessage({ type: 'rejectCommand' }); removeLastActionBar(); }
    function approveEdit() { vscode.postMessage({ type: 'approveEdit' }); removeLastActionBar(); }
    function rejectEdit() { vscode.postMessage({ type: 'rejectEdit' }); removeLastActionBar(); }
    function viewDiff() { vscode.postMessage({ type: 'viewDiff' }); }
    function executePlan() { vscode.postMessage({ type: 'executePlan' }); removeLastActionBar(); }

    function autoFix() {
      if (lastFailedOutput) {
        vscode.postMessage({ type: 'autoFix', ...lastFailedOutput });
      }
    }

    function removeLastActionBar() {
      const bars = document.querySelectorAll('.action-bar');
      if (bars.length > 0) bars[bars.length - 1].remove();
    }

    sendBtn.addEventListener('click', function() {
      const text = messageInput.value.trim();
      if (text) {
        addUserMessage(text);
        vscode.postMessage({ type: 'sendMessage', text: text });
        messageInput.value = '';
      }
    });

    messageInput.addEventListener('keypress', function(e) {
      if (e.key === 'Enter') sendBtn.click();
    });

    window.addEventListener('message', function(event) {
      const msg = event.data;
      switch (msg.type) {
        case 'status': setStatus(msg.text); break;
        case 'response': addAssistantMessage(msg.text); break;
        case 'result': addResultCard(msg.status, msg.title, msg.detail, msg.stdout, msg.stderr, msg.exitCode, msg.durationMs, msg.command); break;
        case 'command': addCommandCard(msg.command, msg.description, msg.cwd); break;
        case 'edit': addEditCard(msg.filePath, msg.instruction, msg.changes); break;
        case 'plan': addPlanCard(msg.steps); break;
      }
    });
  </script>
</body>
</html>`;
  }
}
