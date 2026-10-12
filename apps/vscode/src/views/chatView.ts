import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { EngineTransport } from '../transport.js';

// -------------------------------------------------------------------------
// Enterprise-Grade Intelligent Error Classification (Pillar 4)
// -------------------------------------------------------------------------
type ErrorClassification =
  | { type: 'missing_local_file'; filePath: string; confidence: number }
  | { type: 'missing_dependency'; packageName: string; confidence: number }
  | { type: 'syntax_error'; filePath: string; line: number; column: number; message: string; confidence: number }
  | { type: 'port_in_use'; port: number; confidence: number }
  | { type: 'permission_denied'; filePath: string; confidence: number }
  | { type: 'out_of_memory'; confidence: number }
  | { type: 'network_error'; message: string; confidence: number }
  | { type: 'command_not_found'; command: string; confidence: number }
  | { type: 'git_conflict'; filePath: string; confidence: number }
  | { type: 'unknown'; confidence: number };

function classifyError(command: string, stdout: string, stderr: string): ErrorClassification {
  const rawOutput = (stdout + '\n' + stderr).replace(/\x1b\[[0-9;]*m/g, '').replace(/\r\n/g, '\n');

  const extractLocation = (text: string): { filePath: string; line: number; col: number } | null => {
    const match = text.match(/([a-zA-Z]:\\[^:\n]+|\/[^:\n]+|[a-zA-Z0-9_\-\/\.]+\.(?:ts|tsx|js|jsx|mjs|cjs|json)):(\d+):(\d+)/);
    if (match && match[1] && match[2] && match[3]) {
      return { filePath: match[1].trim(), line: parseInt(match[2], 10), col: parseInt(match[3], 10) };
    }
    return null;
  };

  if (/JavaScript heap out of memory|FATAL ERROR:.*heap limit|Allocation failed/.test(rawOutput)) {
    return { type: 'out_of_memory', confidence: 0.99 };
  }

  const portMatch = rawOutput.match(/EADDRINUSE.*?(\d{2,5})/i) || rawOutput.match(/port (\d+) is already in use/i);
  if (portMatch && portMatch[1]) {
    return { type: 'port_in_use', port: parseInt(portMatch[1], 10), confidence: 0.95 };
  }

  const cmdNotFoundMatch = rawOutput.match(/'([^']+)' is not recognized as an internal or external command/i) ||
    rawOutput.match(/command not found:\s*([^\s\n]+)/i) ||
    rawOutput.match(/spawn\s+([^\s]+)\s+ENOENT/i);
  if (cmdNotFoundMatch && cmdNotFoundMatch[1]) {
    return { type: 'command_not_found', command: cmdNotFoundMatch[1].trim(), confidence: 0.9 };
  }

  const permMatch = rawOutput.match(/EACCES: permission denied,\s*(?:open|scandir|mkdir)\s+'([^']+)'/i) ||
    rawOutput.match(/EPERM:\s*operation not permitted,\s*(?:open|scandir|mkdir)\s+'([^']+)'/i);
  if (permMatch && permMatch[1]) {
    return { type: 'permission_denied', filePath: permMatch[1].trim(), confidence: 0.95 };
  }

  const netMatch = rawOutput.match(/(ENOTFOUND|ETIMEDOUT|ECONNREFUSED|CERT_UNTRUSTED)/);
  if (netMatch && netMatch[1]) {
    return { type: 'network_error', message: `Network failure: ${netMatch[1]}. Check internet or npm registry.`, confidence: 0.9 };
  }

  if (rawOutput.includes('<<<<<<< HEAD') || rawOutput.includes('<<<<<<<')) {
    const conflictFile = rawOutput.match(/Merge conflict in ([^\n]+)/i)?.[1]?.trim() || 'unknown file';
    return { type: 'git_conflict', filePath: conflictFile, confidence: 0.95 };
  }

  const moduleMatch = rawOutput.match(/Cannot find module '([^']+)' from '([^']+)'/i) ||
    rawOutput.match(/Module not found: Error: Can't resolve '([^']+)' in '([^']+)'/i) ||
    rawOutput.match(/Cannot find package '([^']+)' from '([^']+)'/i) ||
    rawOutput.match(/TS2307: Cannot find module '([^']+)'/i);

  if (moduleMatch && moduleMatch[1]) {
    const requested = moduleMatch[1].trim();
    const importingFile = moduleMatch[2]?.trim();

    if (requested.startsWith('.') || requested.startsWith('/') || requested.includes('/') || requested.includes('\\')) {
      let targetFile = requested;

      // If we have the importing file, resolve the relative path properly
      if (importingFile && requested.startsWith('.')) {
        const importingDir = path.dirname(importingFile);
        targetFile = path.posix.join(importingDir, requested);
        // Normalize the path (remove ./ and resolve ../)
        targetFile = path.posix.normalize(targetFile);
      } else {
        // Fallback: just strip the leading ./ or ../
        targetFile = requested.replace(/^\.\//, '').replace(/^\.\.\//, '').replace(/^\.\.\\/, '');
      }

      if (!targetFile.includes('.')) {
        targetFile += '.ts';
      }
      return { type: 'missing_local_file', filePath: targetFile, confidence: 0.95 };
    }

    let packageName = requested;
    if (requested.startsWith('@')) {
      const parts = requested.split('/');
      const scope = parts[0];
      const pkg = parts[1];
      if (scope && pkg) packageName = scope + '/' + pkg;
    } else {
      const parts = requested.split('/');
      const firstPart = parts[0];
      if (firstPart) packageName = firstPart;
    }

    return { type: 'missing_dependency', packageName: packageName, confidence: 0.9 };
  }

  const syntaxMatch = rawOutput.match(/(?:SyntaxError|TS\d+):\s*([^\n]+)\n\s*(?:at\s+)?(?:.*?\()?(.*?\.(?:ts|tsx|js|jsx|mjs|cjs|json)):(\d+):(\d+)/i);
  if (syntaxMatch && syntaxMatch[1] && syntaxMatch[2] && syntaxMatch[3] && syntaxMatch[4]) {
    return {
      type: 'syntax_error',
      filePath: syntaxMatch[2].trim(),
      line: parseInt(syntaxMatch[3], 10),
      column: parseInt(syntaxMatch[4], 10),
      message: syntaxMatch[1].trim(),
      confidence: 0.9
    };
  }

  const fallbackSyntax = rawOutput.match(/(?:SyntaxError|TS\d+):\s*([^\n]+)/i);
  if (fallbackSyntax && fallbackSyntax[1]) {
    const loc = extractLocation(rawOutput);
    if (loc) {
      return {
        type: 'syntax_error',
        filePath: loc.filePath,
        line: loc.line,
        column: loc.col,
        message: fallbackSyntax[1].trim(),
        confidence: 0.8
      };
    }
  }

  if (/Unexpected token|JSONParseError|Unexpected end of JSON input/i.test(rawOutput)) {
    const loc = extractLocation(rawOutput);
    if (loc && (loc.filePath.endsWith('.json') || loc.filePath.includes('package') || loc.filePath.includes('tsconfig'))) {
      return {
        type: 'syntax_error',
        filePath: loc.filePath,
        line: loc.line,
        column: loc.col,
        message: 'Invalid JSON syntax (e.g., trailing comma, missing quote)',
        confidence: 0.95
      };
    }
  }

  return { type: 'unknown', confidence: 0 };
}

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
  private autoFixRetryCount: number = 0;
  private lastFailedCommand: string | null = null;
  private lastFailedStdout: string | null = null;
  private lastFailedStderr: string | null = null;

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
        this.autoFixRetryCount = 0;
        this._postMessage({ type: 'result', status: 'rejected', title: 'Command Cancelled', detail: 'No command was executed.' });
      } else if (data.type === 'autoFix') {
        await this._handleAutoFix(data.command, data.stdout, data.stderr);
      } else if (data.type === 'executePlan') {
        await this._executeActionPlan();
      }
    });
  }

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

      for (const dir of ['src', 'packages', 'apps']) {
        try {
          const tree = await this._listDir(path.join(workspaceFolder, dir), '', 2);
          if (tree) parts.push(`\n${dir}/ structure:\n` + tree);
        } catch { }
      }
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

  private async _parseCommandRequest(message: string): Promise<{ command: string; args: string[]; description: string } | null> {
    const lower = message.toLowerCase();
    if (!lower.startsWith('run ') && !lower.startsWith('execute ') && !lower.startsWith('start ')) {
      return null;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) {
      const parts = message.replace(/^(run|execute|start)\s+/i, '').trim().split(/\s+/).filter(p => p.length > 0);
      return parts.length === 0 ? null : { command: parts[0]!, args: parts.slice(1), description: 'Run: ' + parts.join(' ') };
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

    const parts = message.replace(/^(run|execute|start)\s+/i, '').trim().split(/\s+/).filter(p => p.length > 0);
    return parts.length === 0 ? null : { command: parts[0]!, args: parts.slice(1), description: 'Run generic command: ' + parts.join(' ') };
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

  private async _handleUserMessage(message: string) {
    this.outputChannel.appendLine('[Chat] User: ' + message);
    this.history.push({ role: 'user', content: message });

    const lowerMsg = message.toLowerCase().trim();
    if ((lowerMsg === 'fix the error' || lowerMsg === 'fix it' || lowerMsg === 'fix') && this.lastFailedCommand) {
      this._postMessage({ type: 'status', text: 'Re-analyzing the last failed command...' });
      await this._handleAutoFix(this.lastFailedCommand, this.lastFailedStdout || '', this.lastFailedStderr || '');
      return;
    }

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

      const responseText = result.response || 'No response received.';
      this.history.push({ role: 'assistant', content: responseText });
      this._postMessage({ type: 'response', text: this._formatMarkdown(responseText) });

    } catch (error: any) {
      this._postMessage({ type: 'result', status: 'error', title: 'Query Failed', detail: error.message || String(error) });
    }
  }

  private async _handleDomainRequest(req: { domain: string; action: string; path: string }) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '.';
    const targetPath = path.isAbsolute(req.path) ? req.path : path.join(workspaceFolder, req.path);

    if (req.domain === 'film') {
      if (req.action === 'inspect') {
        this._postMessage({ type: 'status', text: 'Inspecting Film Project & Verifying Media Links...' });
        try {
          const report = await this.transport.request('pack.film.inspect', { path: targetPath }) as any;
          this.outputChannel.appendLine('[Chat] Film inspect raw report: ' + JSON.stringify(report, null, 2));

          const clips = report.clips || [];
          const missing = clips.filter((c: any) => !c.mediaExists);
          let detail = `Project: ${report.root || targetPath}\nTotal Clips: ${clips.length}\n\n--- Media Status ---\nLinked: ${clips.length - missing.length}\nMissing: ${missing.length}`;

          if (missing.length > 0) {
            detail += '\n\nMissing Files:\n' + missing.map((c: any) => `- ${c.clipName} -> ${c.mediaPath}`).join('\n');
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
          if (!diagnosis.missingClips || diagnosis.missingClips.length === 0) {
            this._postMessage({
              type: 'result',
              status: 'success',
              title: 'Film Fix: No Missing Media',
              detail: 'All media references in the timeline are already linked. No fix needed.',
            });
            return;
          }

          let detail = 'Missing Media Detected:\n\n' + diagnosis.proposedRelsinks.map((r: any) => `  Missing: ${r.missingFile}\n  Relink to: ${r.availableFile}\n`).join('\n') + `\nTimeline: ${diagnosis.timelinePath}`;

          this.pendingFilmFix = {
            path: targetPath,
            timelinePath: diagnosis.timelinePath,
            relinks: diagnosis.proposedRelsinks,
          };

          this._postMessage({
            type: 'edit',
            filePath: diagnosis.timelinePath,
            instruction: `Relink ${diagnosis.proposedRelsinks.length} missing media files to available assets`,
            changes: `${diagnosis.proposedRelsinks.length} media references will be updated`,
          });
        } catch (e: any) {
          this._postMessage({ type: 'result', status: 'error', title: 'Film Fix Failed', detail: e.message || String(e) });
        }
      }
    }
  }

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
    this._postMessage({ type: 'status', text: `Executing: ${cmd.command} ${cmd.args.join(' ')}...` });

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

      let detail = `Command: ${cmd.command} ${cmd.args.join(' ')}\nExit code: ${result.exitCode}\nDuration: ${durationSec}s\n`;
      if (result.timedOut) detail += 'WARNING: Command timed out.\n';
      if (result.stdout && result.stdout.trim()) detail += `\n--- stdout ---\n${result.stdout.trim()}`;
      if (result.stderr && result.stderr.trim()) detail += `\n--- stderr ---\n${result.stderr.trim()}`;

      this.history.push({
        role: 'assistant',
        content: `Executed "${cmd.command} ${cmd.args.join(' ')}" — ${success ? 'Succeeded' : 'Failed'} (exit ${result.exitCode}, ${durationSec}s)`,
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
        command: `${cmd.command} ${cmd.args.join(' ')}`
      });

      if (!success) {
        this.lastFailedCommand = cmd.command + ' ' + cmd.args.join(' ');
        this.lastFailedStdout = result.stdout || '';
        this.lastFailedStderr = result.stderr || '';

        this._postMessage({ type: 'status', text: 'Command failed. Automatically diagnosing and fixing...' });
        await new Promise(resolve => setTimeout(resolve, 1000));
        this._handleAutoFix(this.lastFailedCommand, this.lastFailedStdout || '', this.lastFailedStderr || '');
      } else {
        this.autoFixRetryCount = 0;
      }

      this.pendingCommand = null;
    } catch (error: any) {
      this._postMessage({ type: 'result', status: 'error', title: 'Execution Error', detail: error.message || String(error) });
    }
  }

  private async _handleAutoFix(command: string, stdout: string, stderr: string) {
    this.autoFixRetryCount++;
    if (this.autoFixRetryCount > 3) {
      this._postMessage({
        type: 'result',
        status: 'error',
        title: 'Auto-Fix Limit Reached',
        detail: `The agent attempted 3 automatic fixes but the error persists. This usually indicates a complex configuration issue that requires manual intervention.\n\nFailed command: ${command}\n\nPlease review the error output above and fix manually, or provide more specific instructions.`
      });
      this.autoFixRetryCount = 0;
      return;
    }

    this._postMessage({ type: 'status', text: `Analyzing error output (attempt ${this.autoFixRetryCount}/3)...` });
    const classification = classifyError(command, stdout, stderr);

    if (classification.type === 'missing_local_file' && classification.confidence > 0.8) {
      this._postMessage({ type: 'status', text: `Detected missing local file '${classification.filePath}'. Instructing agent to create it...` });
      try {
        const preciseInstruction = `Create the missing local file '${classification.filePath}' with a basic, valid implementation that satisfies the imports. DO NOT suggest 'npm install'. This is a local source file, not an npm package.`;
        await this._autoApplyEdit(classification.filePath, preciseInstruction);

        // After creating the file, re-run the failed command to verify
        this._postMessage({ type: 'status', text: 'File created. Re-running command to verify...' });
        const cmdParts = command.split(' ');
        if (cmdParts.length > 0 && cmdParts[0]) {
          await this._autoRunCommand(cmdParts[0], cmdParts.slice(1));
        }
      } catch (e: any) {
        this._postMessage({ type: 'result', status: 'error', title: 'Auto-Create Failed', detail: e.message });
      }
      return;
    }

    if (classification.type === 'out_of_memory' && classification.confidence > 0.9) {
      this._postMessage({ type: 'status', text: 'Detected Out of Memory. Increasing Node heap size and retrying...' });
      try {
        const cmdParts = command.split(' ');
        await this._autoRunCommand('npx', ['cross-env', 'NODE_OPTIONS=--max-old-space-size=4096', ...cmdParts]);
      } catch (e: any) {
        this._postMessage({ type: 'result', status: 'error', title: 'OOM Retry Failed', detail: e.message });
      }
      return;
    }

    if (classification.type === 'command_not_found' && classification.confidence > 0.8) {
      this._postMessage({ type: 'result', status: 'error', title: 'Command Not Found', detail: `The command '${classification.command}' is not installed or not in your system PATH. Please install it globally or add it to your project's devDependencies.` });
      return;
    }

    if (classification.type === 'permission_denied' && classification.confidence > 0.8) {
      this._postMessage({ type: 'result', status: 'error', title: 'Permission Denied', detail: `Access denied to '${classification.filePath}'. Try running VS Code as Administrator, or check file/folder permissions.` });
      return;
    }

    if (classification.type === 'network_error' && classification.confidence > 0.8) {
      this._postMessage({ type: 'result', status: 'error', title: 'Network Error', detail: `${classification.message} Please check your internet connection or npm registry configuration.` });
      return;
    }

    if (classification.type === 'git_conflict' && classification.confidence > 0.8) {
      this._postMessage({ type: 'result', status: 'error', title: 'Git Merge Conflict', detail: `Merge conflict detected in '${classification.filePath}'. Please resolve the '<<<<<<< HEAD' markers manually before continuing.` });
      return;
    }

    if (classification.type === 'missing_dependency' && classification.confidence > 0.8) {
      this._postMessage({ type: 'status', text: `Detected missing dependency: '${classification.packageName}'. Auto-installing...` });
      try {
        await this._autoRunCommand('npm', ['install', classification.packageName]);
        this._postMessage({ type: 'status', text: 'Dependency installed. Re-running command...' });
        const cmdParts = command.split(' ');
        if (cmdParts.length > 0 && cmdParts[0]) {
          await this._autoRunCommand(cmdParts[0], cmdParts.slice(1));
        }
      } catch (e: any) {
        this._postMessage({ type: 'result', status: 'error', title: 'Auto-Install Failed', detail: e.message });
      }
      return;
    }

    if (classification.type === 'port_in_use' && classification.confidence > 0.8) {
      this._postMessage({ type: 'status', text: `Detected port ${classification.port} in use. Killing process...` });
      try {
        await this._autoRunCommand('npx', ['kill-port', classification.port.toString()]);
        this._postMessage({ type: 'status', text: 'Port cleared. Re-running command...' });
        const cmdParts = command.split(' ');
        if (cmdParts.length > 0 && cmdParts[0]) {
          await this._autoRunCommand(cmdParts[0], cmdParts.slice(1));
        }
      } catch (e: any) {
        this._postMessage({ type: 'result', status: 'error', title: 'Port Kill Failed', detail: e.message });
      }
      return;
    }

    if (classification.type === 'syntax_error' && classification.confidence > 0.8) {
      this._postMessage({ type: 'status', text: `Detected syntax error in ${classification.filePath} at line ${classification.line}. Generating targeted fix...` });
      try {
        const preciseInstruction = `Fix the syntax error at line ${classification.line}. The compiler says: "${classification.message}". Output ONLY the corrected code for this file. Do not change unrelated logic.`;
        await this._handleEditRequest(classification.filePath, preciseInstruction, true, command);
      } catch (e: any) {
        this._postMessage({ type: 'result', status: 'error', title: 'Auto-Patch Failed', detail: e.message });
      }
      return;
    }

    this._postMessage({ type: 'status', text: 'Complex error detected. Consulting AI debugger...' });
    try {
      const diag = await this.transport.request('chat.diagnose', { command, stdout, stderr }) as any;
      const advice = (diag as any).response || diag.fallbackInstruction || diag.instruction;

      if (!diag.filePath && (!diag.actions || diag.actions.length === 0)) {
        if (advice && advice.length > 20) {
          this._postMessage({
            type: 'result',
            status: 'error',
            title: 'AI Debugger Advice',
            detail: 'The error could not be automatically fixed, but the AI suggests:\n\n' + advice
          });
        } else {
          this._postMessage({ type: 'result', status: 'error', title: 'Cannot Auto-Fix', detail: 'Could not identify a specific file or action to fix this error.' });
        }
        return;
      }

      if (diag.actions && Array.isArray(diag.actions) && diag.actions.length > 0) {
        this._postMessage({ type: 'status', text: `Executing ${diag.actions.length} AI-generated fix steps...` });

        for (const action of diag.actions) {
          const typedAction = action as { type: string; command?: string; args?: string[]; filePath?: string; instruction?: string };


          if (typedAction.type === 'run' && typedAction.command === 'npm' && typedAction.args) {
            const firstArg = typedAction.args[0];
            const isInstall = typeof firstArg === 'string' && ['install', 'i', 'add'].includes(firstArg);
            if (isInstall) {
              const targets = typedAction.args.filter((arg: string) => !arg.startsWith('-'));

              const hasLocalPath = targets.some((t: string) => {
                const isScopedPackage = t.startsWith('@') && t.split('/').length >= 2;
                return t.startsWith('.') ||
                  t.startsWith('/') ||
                  t.includes('\\') ||
                  (!isScopedPackage && t.includes('/')) ||
                  /\.(ts|tsx|js|jsx|mjs|cjs|json)$/i.test(t);
              });

              if (hasLocalPath) {
                this.outputChannel.appendLine(`[Auto-Fix Guardrail] Intercepted hallucinated npm install for local path.`);
                this._postMessage({
                  type: 'status',
                  text: `Guardrail Active: Blocked 'npm install'. Detected local file path(s). Generating missing file(s) instead...`
                });

                for (const target of targets) {
                  const isScopedPackage = target.startsWith('@') && target.split('/').length >= 2;
                  const isLocal = target.startsWith('.') || target.startsWith('/') || target.includes('\\') || (!isScopedPackage && target.includes('/')) || /\.(ts|tsx|js|jsx|mjs|cjs|json)$/i.test(target);

                  if (isLocal) {
                    let targetPath = target;
                    if (!/\.[a-z0-9]+$/i.test(targetPath)) {
                      targetPath = targetPath.endsWith('/') || targetPath.endsWith('\\') ? targetPath + 'index.ts' : targetPath + '.ts';
                    }
                    targetPath = path.posix.normalize(targetPath).replace(/\//g, path.sep);

                    const smartInstruction = `CRITICAL FIX: The build failed because this local file is missing. Create the file '${targetPath}' with a valid, minimal, and type-safe implementation that satisfies the importing file's expectations. STRICT RULES: 1. DO NOT output placeholder comments. Write actual working code. 2. Ensure all exported function/variable names match exactly what the importer expects. 3. If this is a utility file, provide standard implementations.`;

                    await this._autoApplyEdit(targetPath, smartInstruction);
                  }
                }
                continue;
              }
            }
          }

          if (typedAction.type === 'edit' && typedAction.filePath && typedAction.instruction) {
            await this._autoApplyEdit(typedAction.filePath, typedAction.instruction);
          } else if (typedAction.type === 'run' && typedAction.command) {
            const cmdStr = `${typedAction.command} ${(typedAction.args || []).join(' ')}`.toLowerCase();
            if (cmdStr.includes('rm -rf /') || cmdStr.includes('del /s /q') || cmdStr.includes('format ')) {
              this.outputChannel.appendLine(`[Auto-Fix Guardrail] Blocked dangerous command: ${cmdStr}`);
              this._postMessage({ type: 'result', status: 'error', title: 'Blocked Dangerous Command', detail: `Refused to execute potentially destructive command: ${typedAction.command} ${(typedAction.args || []).join(' ')}` });
              continue;
            }
            await this._autoRunCommand(typedAction.command, typedAction.args || []);
          }
        }

        this._postMessage({ type: 'status', text: 'Verifying AI fix by re-running the failed command...' });
        const cmdParts = command.split(' ');
        if (cmdParts.length > 0 && cmdParts[0]) {
          await this._autoRunCommand(cmdParts[0], cmdParts.slice(1));
        }
        return;
      }

      this._postMessage({ type: 'status', text: `Found issue in ${diag.filePath}. Generating fix...` });
      await this._handleEditRequest(diag.filePath, diag.instruction, true, command);

    } catch (e: any) {
      this._postMessage({ type: 'result', status: 'error', title: 'Auto-Fix Failed', detail: e.message || String(e) });
    }
  }

  private async _handleEditRequest(filePath: string, instruction: string, isAutoFix: boolean = false, failedCmd: string | null = null) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) {
      this._postMessage({ type: 'result', status: 'error', title: 'No Workspace', detail: 'No workspace is currently open.' });
      return;
    }
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceFolder, filePath);

    this._postMessage({ type: 'status', text: `Reading ${filePath}...` });
    let fileContent = '';
    try {
      fileContent = await fs.readFile(fullPath, 'utf8');
    } catch {
      this._postMessage({ type: 'result', status: 'error', title: 'File Not Found', detail: `Could not find: ${filePath}` });
      return;
    }

    this._postMessage({ type: 'status', text: `Generating edit for ${filePath}...` });
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
      this._postMessage({ type: 'edit', filePath, instruction, changes: lineDiff });
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
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      let fileContent = '';
      try { fileContent = await fs.readFile(fullPath, 'utf8'); } catch { }

      const result = await this.transport.request('chat.edit', { filePath: fullPath, instruction, fileContent }) as any;
      if (result.error) throw new Error(result.error.message);

      await fs.writeFile(fullPath + '.bak', fileContent, 'utf8');
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

      if (result.timedOut) {
        const output = ((result.stdout || '') + (result.stderr || '')).replace(/\x1b\[[0-9;]*m/g, '');
        const hasPass = output.includes('PASS ') || /Tests:\s+\d+ passed/.test(output);
        const hasFail = output.includes('FAIL ') || /failed/.test(output);
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

      if (result.success) {
        this._postMessage({
          type: 'result',
          status: 'success',
          title: 'Film Fix Applied and Verified',
          detail: `Successfully relinked ${result.fixedCount} media files.\nTimeline: ${this.pendingFilmFix.timelinePath}\nAll media references are now linked.`,
        });
        this.history.push({ role: 'assistant', content: `Fixed ${result.fixedCount} missing media links in ${this.pendingFilmFix.timelinePath}` });
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
    return `+${added} added, -${removed} removed`;
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

      this.history.push({ role: 'assistant', content: `Edited ${relativePath}: ${this.pendingEdit.instruction}` });
      this._postMessage({
        type: 'result',
        status: 'success',
        title: 'File Saved Successfully',
        detail: `File: ${relativePath}\nInstruction: ${this.pendingEdit.instruction}\nBackup: ${path.basename(backupPath)}`,
      });

      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(this.pendingEdit.filePath)));

      if (isAutoFix) {
        this._postMessage({ type: 'status', text: 'Verifying AI fix by re-running build...' });
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
            detail: `The AI attempted a fix, but the build still failed (exit code ${verifyResult.exitCode}). Your file has been safely restored from the .bak backup.`
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
      const div = document.createElement('div'); div.className = 'msg msg-user'; div.textContent = text;
      chatContainer.appendChild(div); scrollToBottom();
    }
    function addAssistantMessage(html) {
      removeStatus(); const div = document.createElement('div'); div.className = 'msg msg-assistant'; div.innerHTML = html;
      chatContainer.appendChild(div); scrollToBottom();
    }
    function setStatus(text) {
      removeStatus(); statusBar = document.createElement('div'); statusBar.className = 'status-bar';
      statusBar.innerHTML = '<span class="codicon codicon-sync"></span> ' + text;
      chatContainer.appendChild(statusBar); scrollToBottom();
    }
    function removeStatus() { if (statusBar) { statusBar.remove(); statusBar = null; } }
    function addResultCard(status, title, detail, stdout, stderr, exitCode, durationMs, command) {
      removeStatus();
      const iconMap = { success: 'pass', failure: 'error', error: 'error', rejected: 'close' };
      const colorMap = { success: 'var(--vscode-testing-iconPassed)', failure: 'var(--vscode-testing-iconFailed)', error: 'var(--vscode-errorForeground)', rejected: 'var(--vscode-descriptionForeground)' };
      const div = document.createElement('div'); div.className = 'result-card result-' + status;
      let html = '<div class="result-title"><span class="codicon codicon-' + iconMap[status] + '" style="color:' + colorMap[status] + '"></span> ' + title + '</div>';
      if (detail) html += '<div class="result-detail">' + escapeHtml(detail) + '</div>';
      if (status === 'failure' && command) {
        lastFailedOutput = { command, stdout, stderr };
        html += '<div class="action-bar"><button class="btn-primary" onclick="autoFix()"><span class="codicon codicon-bug"></span> Auto-Fix Error</button></div>';
      }
      div.innerHTML = html; chatContainer.appendChild(div); scrollToBottom();
    }
    function addCommandCard(command, description, cwd) {
      removeStatus(); const div = document.createElement('div'); div.className = 'action-card';
      div.innerHTML = '<h4><span class="codicon codicon-terminal"></span> Command Ready</h4>' +
        '<p><strong>Command:</strong> <code>' + escapeHtml(command) + '</code></p>' +
        '<p><strong>Description:</strong> ' + escapeHtml(description) + '</p>' +
        '<p><strong>Working dir:</strong> <code>' + escapeHtml(cwd) + '</code></p>' +
        '<div class="action-bar"><button class="btn-primary" onclick="runCommand()"><span class="codicon codicon-play"></span> Run Command</button>' +
        '<button class="btn-danger" onclick="rejectCommand()"><span class="codicon codicon-close"></span> Cancel</button></div>';
      chatContainer.appendChild(div); scrollToBottom();
    }
    function addEditCard(filePath, instruction, changes) {
      removeStatus(); const div = document.createElement('div'); div.className = 'action-card';
      div.innerHTML = '<h4><span class="codicon codicon-diff"></span> Proposed Edit</h4>' +
        '<p><strong>File:</strong> <code>' + escapeHtml(filePath) + '</code></p>' +
        '<p><strong>Instruction:</strong> ' + escapeHtml(instruction) + '</p>' +
        '<p><strong>Changes:</strong> ' + escapeHtml(changes) + '</p>' +
        '<div class="action-bar"><button class="btn-secondary" onclick="viewDiff()"><span class="codicon codicon-diff"></span> Preview Diff</button>' +
        '<button class="btn-success" onclick="approveEdit()"><span class="codicon codicon-check"></span> Approve & Save</button>' +
        '<button class="btn-danger" onclick="rejectEdit()"><span class="codicon codicon-close"></span> Reject</button></div>';
      chatContainer.appendChild(div); scrollToBottom();
    }
    function addPlanCard(steps) {
      removeStatus(); const div = document.createElement('div'); div.className = 'action-card';
      div.innerHTML = '<h4><span class="codicon codicon-rocket"></span> Autonomous Plan Ready</h4>' +
        '<p>I have planned ' + steps.length + ' steps to implement your request:</p>' +
        '<ul style="margin: 8px 0 8px 20px; line-height: 1.6;">' + steps.map(s => '<li>' + escapeHtml(s) + '</li>').join('') + '</ul>' +
        '<div class="action-bar"><button class="btn-success" onclick="executePlan()"><span class="codicon codicon-play"></span> Execute Entire Plan</button></div>';
      chatContainer.appendChild(div); scrollToBottom();
    }
    function escapeHtml(text) { if (!text) return ''; return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function scrollToBottom() { chatContainer.scrollTop = chatContainer.scrollHeight; }
    function runCommand() { vscode.postMessage({ type: 'runCommand' }); removeLastActionBar(); }
    function rejectCommand() { vscode.postMessage({ type: 'rejectCommand' }); removeLastActionBar(); }
    function approveEdit() { vscode.postMessage({ type: 'approveEdit' }); removeLastActionBar(); }
    function rejectEdit() { vscode.postMessage({ type: 'rejectEdit' }); removeLastActionBar(); }
    function viewDiff() { vscode.postMessage({ type: 'viewDiff' }); }
    function executePlan() { vscode.postMessage({ type: 'executePlan' }); removeLastActionBar(); }
    function autoFix() { if (lastFailedOutput) vscode.postMessage({ type: 'autoFix', ...lastFailedOutput }); }
    function removeLastActionBar() { const bars = document.querySelectorAll('.action-bar'); if (bars.length > 0) bars[bars.length - 1].remove(); }

    sendBtn.addEventListener('click', function() {
      const text = messageInput.value.trim();
      if (text) { addUserMessage(text); vscode.postMessage({ type: 'sendMessage', text }); messageInput.value = ''; }
    });
    messageInput.addEventListener('keypress', function(e) { if (e.key === 'Enter') sendBtn.click(); });
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
