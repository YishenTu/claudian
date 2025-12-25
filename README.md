# Claudian

![Preview](Preview.png)

An Obsidian plugin that embeds Claude Agent (using Claude Agent SDK) as a sidebar chat interface. Your vault becomes Claude's working directory, giving it full agentic capabilities: file read/write, bash commands, and multi-step workflows.

## Features

- **Full Agentic Capabilities**: Leverage Claude Code's power to read, write, and edit files, and execute bash commands, all within your Obsidian vault.
- **Context-Aware**: Automatically attach the focused note, mention files with `@`, exclude notes by tag, include editor selection, and access external directories for additional context.
- **Vision Support**: Analyze images by sending them via drag-and-drop, paste, or file path.
- **Inline Edit**: Edit selected text or insert content at cursor position directly in notes with word-level diff preview and read-only tool access for context.
- **Slash Commands**: Create reusable prompt templates triggered by `/command`, with argument placeholders, `@file` references, and optional inline bash substitutions.
- **Instruction Mode (`#`)**: Add refined custom instructions to your system prompt directly from the chat input, with review/edit in a modal.
- **Skills**: Extend Claudian with reusable capability modules that are automatically invoked based on context, compatible with Claude Code's skill format.
- **Dynamic Responses**: Experience real-time streaming, observe Claude's extended reasoning process, and cancel responses mid-stream.
- **Write/Edit Diff View**: See inline diffs for Write/Edit tool calls in the chat panel with line stats; large/binary files gracefully skip with a notice.
- **Advanced Model Control**: Select between Haiku, Sonnet, and Opus, configure custom models via environment variables, and fine-tune thinking budget.
- **Transparent Tooling**: Visualize tool calls, subagent activity, and track asynchronous subagent operations with detailed UI feedback.
- **Persistent Sessions**: Save and resume conversations with full context across sessions.
- **Robust Security**: Implement permission modes (YOLO/Safe), a safety blocklist, and vault confinement with symlink-safe checks.
- **Intuitive File Management**: See indicators for edited files, with smart detection, auto-dismissal, and quick access.

## Requirements

- [Claude Code CLI](https://code.claude.com/docs/en/overview) installed (the SDK uses it internally)
- Obsidian v1.8.9+
- Claude subscription/API or Custom model provider that supports anthropic API format (Openrouter, Kimi, GLM, DeepSeek, etc.)
- Desktop only (support macOS, not tested on Linux or Windows)

## Installation

### From GitHub Release (recommended)

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/YishenTu/claudian/releases/latest)
2. Create a folder called `claudian` in your vault's plugins folder:
   ```
   /path/to/vault/.obsidian/plugins/claudian/
   ```
3. Copy the downloaded files into the `claudian` folder
4. Enable the plugin in Obsidian:
   - Settings → Community plugins → Enable "Claudian"

### From source (development)

1. Clone this repository into your vault's plugins folder:
   ```bash
   cd /path/to/vault/.obsidian/plugins
   git clone https://github.com/YishenTu/claudian.git
   cd claudian
   ```

2. Install dependencies and build:
   ```bash
   npm install
   npm run build
   ```

3. Enable the plugin in Obsidian:
   - Settings → Community plugins → Enable "Claudian"

### Development

```bash
# Watch mode
npm run dev

# Production build
npm run build
```

## Usage

**Two modes:**
1. Click the bot icon in ribbon or launch Claudian in palette
2. Select text in any note and press hotkey to open inline edit

Use it like Claude Code, ask it to read, write, edit, search, etc. to help you with your notes.

### File Context

- **Auto-attach**: New conversations auto-attach the currently focused note
- **@ mention**: Type `@` anywhere to search and attach files from your vault
- **Excluded tags**: Notes with tags listed in Settings → Excluded tags won't auto-attach (but can still be manually attached via `@`)
- Files are sent as context with your message; Claude will read them to understand your question

### Selection Context

Select text in any note, then click the chat input - your selection is automatically included as context.

- **Visual indicator**: "X lines selected" badge appears in the input area
- **Preserved highlight**: Selection stays visually highlighted even after clicking input
- **Automatic inclusion**: Selected text is sent with your message as `<editor_selection>` context
- **Persistent context**: Selection stays active until cleared or replaced

### Context Paths

Grant Claude read-only access to directories outside your vault for additional context (e.g., reference data, shared resources, project files).

- **Folder icon**: Click the folder icon in the input toolbar to add paths via native folder picker
- **Visual feedback**: Icon glows when paths are configured; badge shows count when >1
- **Hover dropdown**: View configured paths and remove with ✕
- **Read-only access**: Claude can read files (`Read`, `Glob`, `Grep`, `LS`) and use bash read operations, but cannot write to these paths
- **Office documents**: With appropriate tools installed (`pandoc`, `xlsx2csv`), Claude can extract text from `.docx`, `.xlsx`, `.pptx` files

### Image Context

Send images to Claude via drag-and-drop, paste (Cmd/Ctrl+V), or file path in your message.

**Supported:** JPEG, PNG, GIF, WebP (max 5MB)

**Embedded images:** Configure media folder in settings, then Claude can read `![[image.png]]` references.

### Inline Edit

Interact with text directly in your notes - ask questions, request edits, or insert new content - without opening the sidebar chat.

**Features:**
- **Selection & cursor modes**: Edit selected text or insert at cursor position
- **Multi-turn conversation**: Agent can ask clarifying questions
- **Read-only tools**: Agent can read files and search the web for context
- **Inline diff**: Word-level diff with red strikethrough (deletions) and green highlight (insertions)

### Slash Commands

Define commands in Settings → Claudian → Slash Commands, then type `/` in the chat input or inline edit input to select a command.

- **Invocation**: `/commandName arguments...`
- **Placeholders**: `$ARGUMENTS`, `$1`, `$2`, ... (basic quoted args supported)
- **File references**: `@path/to/file.md`, `@"path with spaces.md"`, `@'path with spaces.md'`
- **Inline bash**: `` !`command` `` substitutes with command output (see safety notes below)

### Instruction Mode (`#`)

Use `#` at the start of the chat input to add a refined instruction to Settings → Custom system prompt.

1. Type `#` (or `# `) at the start of your message to enter instruction mode
2. Type your instruction and press Enter
3. A modal opens immediately (loading → clarification or confirmation)
4. Review the refined snippet, optionally edit it, then Accept to save

Accepted content is appended to the custom system prompt as-is. The agent decides the best Markdown format (single bullet, multiple bullets, or a small section).

### Skills

Extend Claudian with reusable capability modules. Skills are `SKILL.md` files with YAML frontmatter that Claude discovers and invokes automatically based on context.

- **User skills**: `~/.claude/skills/{name}/SKILL.md` (all vaults)
- **Project skills**: `{vault}/.claude/skills/{name}/SKILL.md` (vault-specific)

Compatible with [Claude Code's Skills format](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview). Ask "What skills are available?" to list discovered skills.

### Example prompts

- "List all notes in this vault"
- "Create a new note called 'Ideas' with a template for brainstorming"
- "Find all notes tagged #project and summarize them"
- "Organize my daily notes into monthly folders"
- "Summarize this note" (with a note attached via @ or auto-attach)

## Configuration

### Settings

- **Enable command blocklist**: Block dangerous bash commands (default: on)
- **Blocked commands**: Patterns to block (supports regex)
- **Allowed export paths**: Paths outside the vault where files can be exported (default: `~/Desktop`, `~/Downloads`)
- **Context paths**: Directories outside the vault that Claude can read for additional context (click folder icon in input toolbar)
- **Show tool usage**: Display file operations in chat
- **Excluded tags**: Tags that prevent notes from auto-loading (e.g., `sensitive`, `private`)
- **Media folder**: Configure where vault stores attachments for embedded image support (e.g., `attachments`)
- **Custom system prompt**: Additional instructions appended to the default system prompt (Instruction Mode `#` saves here)
- **Permission mode**: Toggle YOLO (bypass prompts) or Safe (require approval)
- **Approved actions**: In Safe mode, manage permanently approved actions (Allow Once vs. Always Allow)
- **Slash commands**: Create/edit/import/export custom `/commands` (optionally override model and allowed tools)
- **Environment variables**: Custom environment variables for Claude SDK (KEY=VALUE format)
- **Environment snippets**: Save and restore environment variable configurations

### Safety and permissions

- **Vault restriction**: File tools and Bash commands are limited to the Obsidian vault. Paths are resolved with `realpath` to prevent symlink escapes; attempts outside the vault are blocked.
- **Export paths exception**: Write operations to configured export paths (e.g., `~/Desktop`) are allowed for export workflows (e.g., `pandoc` generating `.docx`). Export paths are treated as write-only: `Read/Glob/Grep/LS` remain vault-only, and `Bash` only allows export paths as write targets (e.g., `-o/--output`, `>`).
- **Context paths exception**: Read operations from configured context paths are allowed. Context paths are read-only: `Read/Glob/Grep/LS` work, `Bash` allows read operations (e.g., `cat`, `pandoc ... -t plain`), but all write operations are blocked.
- **Approvals**:
  - Safe mode shows an approval modal per tool call.
  - Bash approvals require an exact command match.
  - File tools allow exact or prefix path matches.
- **Inline bash in slash commands**:
  - In Safe mode, each `` !`command` `` substitution prompts for approval.
  - The command blocklist also applies.
  - Inline-bash prompts are "Allow once" only (no permanent approval).
- **Command blocklist**:
  - `rm -rf`
  - `chmod 777`
  - `chmod -R 777`
  - etc. 

## Privacy & Data Use

- **Outbound scope**: Content sent to Claude/custom APIs includes your input, attached files/snippets, images (base64), and model-issued tool calls plus summarized outputs. Default provider is Anthropic; if `ANTHROPIC_BASE_URL` is set, traffic goes to that endpoint.
- **Local storage**: Settings, chat history, approved actions, and environment variable snippets are stored in `.obsidian/plugins/claudian`. Image cache is written to `.claudian-cache/images`; you can clear it when deleting conversations or uninstalling the plugin.
- **Commands & file access**: The plugin can read/write files and execute Bash commands within the vault directory; Safe mode approvals and the blocklist apply, and paths are constrained to the vault via `realpath`.
- **User controls**: You can edit the blocked-command list, switch Safe/YOLO modes, clear history, delete caches, and remove API keys; disabling the plugin stops all remote calls.
- **Telemetry**: No additional telemetry or third-party tracking. Data retention/compliance follows the terms of your configured API provider.

## Architecture

```
src/
├── main.ts              # Plugin entry point
├── ClaudianView.ts      # Sidebar chat UI, orchestrates components
├── ClaudianService.ts   # Claude Agent SDK wrapper (includes session & diff management)
├── ClaudianSettings.ts  # Settings tab
├── types.ts             # Type definitions (re-exports from types/)
├── utils.ts             # Utilities (vault, env, context files, session recovery)
├── services/            # Claude-facing services and subagent state
│   ├── InlineEditService.ts # Lightweight Claude service for inline editing
│   ├── InstructionRefineService.ts # Lightweight Claude service for refining # instructions
│   └── AsyncSubagentManager.ts # Async subagent state machine
├── system-prompt/       # System prompts for different agents
│   ├── mainAgent.ts          # Main chat system prompt
│   ├── inlineEdit.ts         # Inline edit system prompt
│   └── instructionRefine.ts  # Instruction refinement system prompt
├── sdk/                 # SDK integration
│   └── MessageTransformer.ts # SDK message transformation
├── hooks/               # SDK PreToolUse/PostToolUse hooks
│   ├── SecurityHooks.ts      # Blocklist and vault restriction hooks
│   └── DiffTrackingHooks.ts  # File content capture for diff view
├── security/            # Security utilities
│   ├── ApprovalManager.ts    # Tool approval management
│   ├── BlocklistChecker.ts   # Command blocklist checking
│   └── BashPathValidator.ts  # Bash command path validation
├── tools/               # Tool utilities
│   ├── toolNames.ts          # Tool name constants
│   ├── toolIcons.ts          # Tool icon mapping
│   └── toolInput.ts          # Tool input parsing
├── images/              # Image handling
│   ├── imageCache.ts         # Image caching with SHA-256 deduplication
│   └── imageLoader.ts        # Image loading utilities
├── types/               # Type definitions (modular)
│   ├── models.ts, settings.ts, chat.ts, tools.ts, sdk.ts
│   └── index.ts              # Barrel export
└── ui/                  # Modular UI components
    ├── index.ts              # Barrel export
    ├── ApprovalModal.ts      # Permission approval dialog
    ├── InputToolbar.ts       # Model/thinking/permission selectors
    ├── FileContext.ts        # File attachments & @mentions
    ├── ImageContext.ts       # Image drag/drop, paste, path detection
    ├── SlashCommandManager.ts # Slash command detection and expansion
    ├── SlashCommandDropdown.ts # Slash command dropdown UI
    ├── SlashCommandSettings.ts # Slash command settings UI
    ├── ToolCallRenderer.ts   # Tool call display
    ├── ThinkingBlockRenderer.ts # Extended thinking UI
    ├── TodoListRenderer.ts   # Todo list UI for task tracking
    ├── SubagentRenderer.ts   # Subagent UI component
    ├── DiffRenderer.ts       # Diff computation and rendering
    ├── WriteEditRenderer.ts  # Write/Edit diff blocks
    ├── EnvSnippetManager.ts  # Environment variable snippets
    ├── InlineEditModal.ts    # Inline edit UI (CM6 decorations, diff view)
    ├── InstructionModeManager.ts # # instruction mode detection and UI state
    ├── InstructionConfirmModal.ts # Unified instruction modal
    └── SelectionHighlight.ts # Shared CM6 selection highlight (chat + inline edit)
```

## Roadmap

- [x] Session persistence within sessions
- [x] Chat history persistence across plugin restarts
- [x] Conversation switching with history dropdown
- [x] File context awareness (auto-attach + @ mention)
- [x] Context menu: "Ask Claude about this file"
- [x] Extended thinking display
- [x] Model selection
- [x] Thinking token budget adjustment
- [x] Permission modes (YOLO/Safe)
- [x] Edited files indicator for Claude edits
- [x] Environment variables support with snippet management
- [x] Image support
- [x] Subagent visualization with nested tool tracking
- [x] Async subagent support
- [x] Inline edit feature
- [x] Diff view in chat panel
- [x] Cursor position awareness in inline edit
- [x] Slash commands
- [x] Instruction mode (`#`) to save in custom system prompt
- [x] Skills support (Claude Code compatible)
- [x] Selection awareness in main chat (visual indicator + context)
- [x] Context paths for read-only access to external directories
- [ ] Hooks, MCP and other advanced features

## License

Licensed under the [MIT License](LICENSE).

## Acknowledgments

- [Obsidian](https://obsidian.md) for the plugin API
- [Anthropic](https://anthropic.com) for Claude and the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview)
