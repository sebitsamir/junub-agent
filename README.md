# Junub Agent

A local-first, autonomous AI coding assistant for Visual Studio Code.

Junub Agent reads your codebase, executes terminal commands, diagnoses build failures, and applies verified code fixes. It operates entirely within your editor, with support for fully offline execution via Ollama or cloud-based reasoning via OpenRouter.

---

## Overview

Junub Agent is a VS Code extension that provides an AI pair programmer integrated directly into your development workflow. It does not merely generate text responses. It executes actions: running builds, analyzing errors, identifying broken files, and applying surgical patches to resolve them.

Every modification requires explicit user approval, and every AI-generated fix is automatically verified by re-running the build. If verification fails, the original file is restored from a backup.

---

## Features

### Context-Aware Chat

The agent silently reads your workspace structure before answering questions. It inspects top-level directories, `src/`, `packages/`, `apps/`, and `package.json` to provide grounded responses based on your actual codebase.

- Reads workspace structure and dependency manifest before every query
- Answers questions using only real files and paths from the project
- Supports multi-turn conversation with context history
- No hallucinated file paths or invented modules

### Terminal Execution

Run build, test, lint, and development commands directly from the chat panel.

- Executes any shell command with full stdout and stderr capture
- Reports exit codes, duration, and timeout status
- Supports Windows `.cmd` scripts (npm, pnpm, npx)
- Displays results in structured cards with pass/fail indicators

### Agentic Auto-Fix Loop

When a build or test command fails, the agent can autonomously diagnose and repair the error.

1. **Diagnose** — Analyzes terminal output to identify the failing file and root cause
2. **Generate** — Produces a targeted SEARCH/REPLACE patch using the identified context
3. **Apply** — Writes the fix to disk after user approval
4. **Verify** — Re-runs the original command to confirm the fix resolves the error
5. **Revert** — Restores the original file from backup if verification fails

### Safety Guardrails

- **Auto-Revert Protection:** Every AI edit is verified by re-running the originating command. If the build still fails, the file is automatically restored from a `.bak` backup.
- **Human-in-the-Loop:** No file is modified without explicit user approval.
- **Diff Preview:** Users may inspect the proposed changes in VS Code's native diff editor before saving.
- **Truncation Guard:** If the model output is significantly shorter than the original file, the edit is rejected to prevent data loss.

### Multi-Provider Support

| Provider | Mode | Recommended Models |
|----------|------|-------------------|
| Ollama | Local, offline | qwen2.5:3b, llama3.2, mistral |
| OpenRouter | Cloud | qwen/qwen-2.5-72b-instruct, anthropic/claude-3.5-sonnet |
| DashScope | Cloud | qwen-max, qwen-plus |

Local providers offer privacy and zero cost. Cloud providers offer superior reasoning for complex tasks such as structural code repair.

---

## Installation

### Prerequisites

- Node.js 18 or later
- Visual Studio Code 1.80 or later
- pnpm (required only when building from source)

### From VSIX Package

1. Download the latest `.vsix` file from the Releases page.
2. Open VS Code.
3. Navigate to the Extensions view (`Ctrl+Shift+X`).
4. Open the overflow menu (`...`) and select **Install from VSIX...**
5. Select the downloaded file and reload the window when prompted.

### From Source

bash
git clone https://github.com/sebitsamir/junub-agent.git
cd junub-agent
pnpm install
pnpm build


Open the `apps/vscode` directory in VS Code and press `F5` to launch the Extension Development Host.

---

## Configuration

Open VS Code Settings (`Ctrl+,`) and search for **Junub Agent**.

### Local Execution (Ollama)

1. Install [Ollama](https://ollama.ai/) and pull a model:


bash
ollama pull qwen2.5:3b

2. In VS Code Settings:
   - **Provider:** `ollama`
   - **Qwen Model:** `qwen2.5:3b`
   - **Qwen Base URL:** Leave empty (defaults to `http://localhost:11434/v1`)

### Cloud Execution (OpenRouter)

1. Obtain an API key from [openrouter.ai](https://openrouter.ai/).
2. In VS Code Settings:
   - **Provider:** `openrouter`
   - **Dashscope API Key:** Your OpenRouter API key
   - **Qwen Model:** `qwen/qwen-2.5-72b-instruct`
   - **Qwen Base URL:** Leave empty (defaults to `https://openrouter.ai/api/v1`)

### Cloud Execution (DashScope)

1. Obtain an API key from [DashScope](https://dashscope.aliyuncs.com/).
2. In VS Code Settings:
   - **Provider:** `dashscope`
   - **Dashscope API Key:** Your DashScope API key
   - **Qwen Model:** `qwen-max`

---

## Usage

### Conversational Queries

Type any question about your project into the chat panel:

summarize the architecture
what dependencies does this project use
explain the purpose of src/lib/engine.mjs


The agent reads your workspace context before responding and references only files that exist in your project.

### Terminal Commands
run build
run the tests
run lint
run dev
run pnpm --filter @junub-agent/kernel test


The agent presents a Command Ready card showing the exact command, arguments, and working directory. Click **Run Command** to execute or **Cancel** to abort.

### Auto-Fix Workflow

1. Execute a command that fails: `run build`
2. When the failure card appears, click **Auto-Fix Error**
3. The agent analyzes the error output and proposes a targeted patch
4. Review the proposed changes using **Preview Diff**
5. Click **Approve and Save** to apply the fix
6. The agent automatically re-runs the build to verify the fix
7. If verification passes, the fix is kept. If it fails, the file is reverted.

### Direct File Editing

edit src/lib/utils.ts to add a formatDate function that returns ISO 8601 format
modify src/app/page.tsx to wrap the component in an error boundary


The agent reads the file, generates a patch, and presents it for approval before writing to disk.

---

## Architecture

junub-agent/
├── apps/
│ └── vscode/ # VS Code extension
│ └── src/
│ ├── extension.ts # Extension entry point and provider configuration
│ ├── transport.ts # JSON-RPC IPC transport to the engine process
│ └── views/
│ └── chatView.ts # Chat UI: RAG, commands, auto-fix, guardrails
├── src/
│ ├── engine.mjs # Headless engine: routing, planning, execution
│ └── lib/
│ ├── process.mjs # Terminal execution with Windows shell support
│ ├── providers.mjs # Model provider selection and routing
│ ├── actions.mjs # Step action definitions
│ ├── inspect.mjs # Workspace inspection utilities
│ └── verify.mjs # Verification and validation
├── packages/
│ ├── contracts/ # Protocol definitions and shared types
│ ├── kernel/ # Task scheduler and event store
│ ├── models/ # LLM provider adapters (Qwen, Fake)
│ ├── storage/ # SQLite persistence layer
│ └── knowledge/ # Knowledge management
├── packs/
│ ├── software/ # Software domain pack
│ └── film/ # Film editing domain pack (EDL timelines)
└── docs/ # Architecture decision records


### Execution Flow

1. User submits a message in the chat panel.
2. The extension reads workspace context and forwards the request to the engine via JSON-RPC over stdio.
3. The engine routes the request to the configured LLM provider.
4. The LLM returns a structured response (answer, edit patch, or command).
5. The engine applies safety checks and returns the result to the extension.
6. The extension presents the result and awaits user approval for file modifications.
7. Upon approval, the modification is applied, verified, and backed up.

---

## Command Reference

| Input | Action |
|-------|--------|
| `run build` | Executes `npm run build` in the workspace root |
| `run test` / `run the tests` | Executes `npm test` |
| `run lint` | Executes `npm run lint` |
| `run dev` | Executes `npm run dev` |
| `run <command>` | Executes any arbitrary command |
| `edit <file> to <instruction>` | Proposes a targeted file edit |
| `modify <file> to <instruction>` | Alias for edit |
| Free-form text | Conversational query with workspace context |

---

## Roadmap

- [x] Context-aware chat with workspace inspection
- [x] Terminal command execution with output capture
- [x] Agentic auto-fix loop with diagnosis and patching
- [x] Multi-provider model routing (Ollama, OpenRouter, DashScope)
- [x] Auto-revert guardrail with backup verification
- [x] Professional persistent UI with result cards
- [ ] VS Code Marketplace publication
- [ ] Inline editor integration (context menu actions)
- [ ] Multi-file refactoring support
- [ ] Automated test generation from specifications
- [ ] Film pipeline domain pack (EDL timeline editing)

---

## Contributing

Contributions are welcome. Please review the contributing guidelines in `docs/contributing.md` before submitting a pull request.

### Development Setup

```bash
git clone https://github.com/YOUR_USERNAME/junub-agent.git
cd junub-agent
pnpm install
pnpm build
cd apps/vscode

Open the apps/vscode folder in VS Code and press F5 to launch the extension in a new Extension Development Host window.

Project Structure
This repository uses a pnpm workspace monorepo. All packages are located under packages/, domain packs under packs/, and the VS Code extension under apps/vscode/.

License
MIT

Acknowledgments
Ollama for local model inference
OpenRouter for unified access to cloud language models
Visual Studio Code Extension API for the extension platform
