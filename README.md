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
- **MCP Support**: Connect external tools and data sources via Model Context Protocol servers (stdio, SSE, HTTP) with context-saving mode and `@`-mention activation.

- **Advanced Model Control**: Select between Haiku, Sonnet, and Opus, configure custom models via environment variables, and fine-tune thinking budget. Monitor context window usage with a real-time gauge.

- **Plan Mode**: Toggle read-only exploration with Shift+Tab before implementation. Agent explores codebase, presents a plan, then implements after approval.

- **Robust Security**: Implement permission modes (YOLO/Safe), a safety blocklist, and vault confinement with symlink-safe checks.
- **Vim-style Navigation**: Press Escape to focus the chat panel, then use `w/s` (configurable) to scroll and `i` to focus input.

## Requirements

- [Claude Code CLI](https://code.claude.com/docs/en/overview) installed (the SDK uses it internally)
- Obsidian v1.8.9+
- Claude subscription/API or Custom model provider that supports anthropic API format (Openrouter, Kimi, GLM, DeepSeek, etc.)
- Desktop only (macOS, Linux, Windows)

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
1. Click the bot icon in ribbon or use command palette to open chat
2. Select text + hotkey for inline edit

Use it like Claude Code—read, write, edit, search files in your vault.

### Context

- **File**: Auto-attaches focused note; type `@` to attach other files
- **@-mention dropdown**: Type `@` to see MCP servers, context folders, and vault files
  - `@server-name` enables context-saving MCP servers
  - `@folder/` filters to files from that context path (e.g., `@workspace/`)
  - Vault files shown by default
- **Selection**: Select text in editor, then chat—selection included automatically
- **Images**: Drag-drop, paste, or type path; configure media folder for `![[image]]` embeds
- **External paths**: Click folder icon in toolbar for read-only access to directories outside vault

### Features

- **Inline Edit**: Select text + hotkey to edit directly in notes with word-level diff preview
- **Slash Commands**: Type `/` for custom prompt templates (Settings → Slash Commands)
- **Instruction Mode**: Type `#` to add refined instructions to system prompt
- **Plan Mode**: `Shift+Tab` for read-only exploration before implementation
- **Skills**: Add `SKILL.md` files to `~/.claude/skills/` or `{vault}/.claude/skills/`
- **MCP**: Add external tools via Settings → MCP Servers; use `@server-name` in chat to activate

## Configuration

### Settings

- **Enable command blocklist**: Block dangerous bash commands (default: on)
- **Blocked commands**: Patterns to block (supports regex)
- **Allowed export paths**: Paths outside the vault where files can be exported (default: `~/Desktop`, `~/Downloads`). Supports `~`, `$VAR`, `${VAR}`, and `%VAR%` (Windows).
- **Context paths**: Directories outside the vault that Claude can read for additional context (click folder icon in input toolbar)
- **Excluded tags**: Tags that prevent notes from auto-loading (e.g., `sensitive`, `private`)
- **Media folder**: Configure where vault stores attachments for embedded image support (e.g., `attachments`)
- **Custom system prompt**: Additional instructions appended to the default system prompt (Instruction Mode `#` saves here)
- **Title generation model**: Model used for auto-generating conversation titles (default: Auto/Haiku)
- **Permission mode**: Toggle YOLO (bypass prompts) or Safe (require approval)
- **Approved actions**: In Safe mode, manage permanently approved actions (Allow Once vs. Always Allow)
- **Slash commands**: Create/edit/import/export custom `/commands` (optionally override model and allowed tools)
- **Environment variables**: Custom environment variables for Claude SDK (KEY=VALUE format)
- **Environment snippets**: Save and restore environment variable configurations
- **MCP Servers**: Add/edit/test/delete MCP server configurations with context-saving mode
- **Vim-style navigation mappings**: Configure key bindings with lines like `map w scrollUp`, `map s scrollDown`, `map i focusInput`

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
- **Command blocklist** (platform-detected):
  - Unix: `rm -rf`, `chmod 777`, `chmod -R 777`
  - Windows CMD: `del /s /q`, `rd /s /q`, `rmdir /s /q`, `format`, `diskpart`
  - Windows PowerShell: `Remove-Item -Recurse -Force`, `Format-Volume`, `Clear-Disk` 

## Privacy & Data Use

- **Outbound scope**: Content sent to Claude/custom APIs includes your input, attached files/snippets, images (base64), and model-issued tool calls plus summarized outputs. Default provider is Anthropic; if `ANTHROPIC_BASE_URL` is set, traffic goes to that endpoint.
- **Local storage**: Data is stored in a distributed format (like Claude Code):
  - `vault/.claude/settings.json` - User settings and permissions (shareable)
  - `vault/.claude/mcp.json` - MCP server configurations (Claude Code compatible)
  - `vault/.claude/commands/*.md` - Slash commands as Markdown files
  - `vault/.claude/sessions/*.jsonl` - Chat sessions (one file per conversation)
  - `.obsidian/plugins/claudian/data.json` - Machine state (active conversation, model tracking)
  - `.claudian-cache/images/` - Image cache (SHA-256 deduplicated)
- **Migration**: Existing users are automatically migrated from the old single-file format on first load. Migration will be removed in v2.0.
- **Commands & file access**: The plugin can read/write files and execute Bash commands within the vault directory; Safe mode approvals and the blocklist apply, and paths are constrained to the vault via `realpath`.
- **User controls**: You can edit the blocked-command list, switch Safe/YOLO modes, clear history, delete caches, and remove API keys; disabling the plugin stops all remote calls.
- **Telemetry**: No additional telemetry or third-party tracking. Data retention/compliance follows the terms of your configured API provider.

## Architecture

```
src/
├── main.ts                      # Plugin entry point
├── core/                        # Core infrastructure
│   ├── agent/                   # Claude Agent SDK wrapper (ClaudianService)
│   ├── hooks/                   # PreToolUse/PostToolUse hooks
│   ├── images/                  # Image caching and loading
│   ├── mcp/                     # MCP server config management (McpServerManager)
│   ├── prompts/                 # System prompts for agents
│   ├── sdk/                     # SDK message transformation
│   ├── security/                # Approval, blocklist, path validation
│   ├── storage/                 # Distributed storage system
│   ├── tools/                   # Tool constants and utilities
│   └── types/                   # Type definitions
├── features/                    # Feature modules
│   ├── chat/                    # Main chat view with modular controllers
│   ├── inline-edit/             # Inline edit service
│   ├── mcp/                     # MCP @-mention detection and connection testing
│   └── settings/                # Settings tab (ClaudianSettings)
├── ui/                          # UI components
│   ├── components/              # Input toolbar, file/image context, dropdowns, AskUserQuestion panel
│   ├── modals/                  # Approval, inline edit, instruction, MCP modals
│   ├── renderers/               # Thinking blocks, tool calls, diffs, subagents, AskUserQuestion
│   └── settings/                # Env snippets, MCP settings, slash commands
├── utils/                       # Modular utility functions
└── style/                       # Modular CSS (→ styles.css)
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
- [x] Distributed storage (settings, commands, sessions as separate files)
- [x] Windows platform support (MSYS paths, PowerShell blocklist, env vars)
- [x] MCP (Model Context Protocol) server support with context-saving mode
- [x] Context window usage display
- [x] Plan mode (Shift+Tab toggle, read-only exploration, approval flow)
- [x] Auto title generation (AI-powered, concurrent, with regenerate option)
- [x] Context path @-mention (`@folder/` to filter files from external directories)
- [ ] Hooks and other advanced features

## License

Licensed under the [MIT License](LICENSE).

## Acknowledgments

- [Obsidian](https://obsidian.md) for the plugin API
- [Anthropic](https://anthropic.com) for Claude and the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview)
