# Claudian

![Preview](Preview.png)

An Obsidian plugin that embeds Claude Agent (using Claude Agent SDK) as a sidebar chat interface. Your vault becomes Claude's working directory, giving it full agentic capabilities: file read/write, search, bash commands, and multi-step workflows.

## Features

- **Full Agentic Capabilities**: Leverage Claude Code's power to read, write, and edit files, search, and execute bash commands, all within your Obsidian vault.
- **Context-Aware**: Automatically attach the focused note, mention files with `@`, exclude notes by tag, include editor selection (Highlight), and access external directories for additional context.
- **Vision Support**: Analyze images by sending them via drag-and-drop, paste, or file path.
- **Inline Edit**: Edit selected text or insert content at cursor position directly in notes with word-level diff preview and read-only tool access for context.
- **Slash Commands**: Create reusable prompt templates triggered by `/command`, with argument placeholders, `@file` references, and optional inline bash substitutions.
- **Instruction Mode (`#`)**: Add refined custom instructions to your system prompt directly from the chat input, with review/edit in a modal.
- **Skills**: Extend Claudian with reusable capability modules that are automatically invoked based on context, compatible with Claude Code's skill format.
- **MCP Support**: Connect external tools and data sources via Model Context Protocol servers (stdio, SSE, HTTP) with context-saving mode and `@`-mention activation.
- **Advanced Model Control**: Select between Haiku, Sonnet, and Opus, configure custom models via environment variables, and fine-tune thinking budget.
- **Security**: Permission modes (YOLO/Safe), safety blocklist, and vault confinement with symlink-safe checks.

> **Note**: `Plan Mode` has been temporarily removed. The SDK does not natively support `permissionMode: plan`, and the previous implementation had significant limitations. It will be re-added when there's a better approach.

## Requirements

- [Claude Code CLI](https://code.claude.com/docs/en/overview) installed
- Obsidian v1.8.9+
- Claude subscription/API or Custom model provider that supports Anthropic API format ([Openrouter](https://openrouter.ai/docs/guides/guides/claude-code-integration), [Kimi](https://platform.moonshot.ai/docs/guide/agent-support), [GLM](https://docs.z.ai/devpack/tool/claude), [DeepSeek](https://api-docs.deepseek.com/guides/anthropic_api), etc.)
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
- **@-mention dropdown**: Type `@` to see active MCP servers, external contexts, and vault files
  - `@mcp-server` enables context-saving MCP servers
  - `@folder/` filters to files from that external context (e.g., `@workspace/`)
  - Vault files shown by default
- **Selection**: Select text in editor, then chat—selection included automatically
- **Images**: Drag-drop, paste, or type path; configure media folder for `![[image]]` embeds
- **External contexts**: Click folder icon in toolbar for access to directories outside vault

### Features

- **Inline Edit**: Select text + hotkey to edit directly in notes with word-level diff preview
- **Slash Commands**: Type `/` for custom prompt templates (Settings → Slash Commands)
- **Instruction Mode**: Type `#` to add refined instructions to system prompt
- **Skills**: Add `SKILL.md` files to `~/.claude/skills/` or `{vault}/.claude/skills/`
- **MCP**: Add external tools via Settings → MCP Servers; use `@mcp-server` in chat to activate

## Configuration

### Settings

**Customization**
- **User name**: Your name for personalized greetings
- **Excluded tags**: Tags that prevent notes from auto-loading (e.g., `sensitive`, `private`)
- **Media folder**: Configure where vault stores attachments for embedded image support (e.g., `attachments`)
- **Custom system prompt**: Additional instructions appended to the default system prompt (Instruction Mode `#` saves here)
- **Auto-generate conversation titles**: Toggle AI-powered title generation after first exchange
- **Title generation model**: Model used for auto-generating conversation titles (default: Auto/Haiku)
- **Vim-style navigation mappings**: Configure key bindings with lines like `map w scrollUp`, `map s scrollDown`, `map i focusInput`

**Hotkeys**
- **Inline edit hotkey**: Hotkey to trigger inline edit on selected text
- **Open chat hotkey**: Hotkey to open the chat sidebar

**Slash Commands**
- Create/edit/import/export custom `/commands` (optionally override model and allowed tools)

**MCP Servers**
- Add/edit/verify/delete MCP server configurations with context-saving mode

**Safety**
- **Load user Claude settings**: Load `~/.claude/settings.json` (user's Claude Code permission rules may bypass Safe mode)
- **Enable command blocklist**: Block dangerous bash commands (default: on)
- **Blocked commands**: Patterns to block (supports regex, platform-specific)
- **Allowed export paths**: Paths outside the vault where files can be exported (default: `~/Desktop`, `~/Downloads`). Supports `~`, `$VAR`, `${VAR}`, and `%VAR%` (Windows).

**Environment**
- **Custom variables**: Environment variables for Claude SDK (KEY=VALUE format)
- **Environment snippets**: Save and restore environment variable configurations

**Advanced**
- **Claude CLI path**: Custom path to Claude Code CLI (leave empty for auto-detection)

## Safety and Permissions

| Scope | Access |
|-------|--------|
| **Vault** | Full read/write (symlink-safe via `realpath`) |
| **Export paths** | Write-only (e.g., `~/Desktop`, `~/Downloads`) |
| **External contexts** | Full read/write (session-only, added via folder icon) |

- **YOLO mode**: No approval prompts; all tool calls execute automatically (default)
- **Safe mode**: Approval modal per tool call; Bash requires exact match, file tools allow prefix match

## Privacy & Data Use

- **Sent to API**: Your input, attached files, images, and tool call outputs. Default: Anthropic; custom endpoint via `ANTHROPIC_BASE_URL`.
- **Local storage**: Settings, sessions, and commands stored in `vault/.claude/`; image cache in `.claudian-cache/`.
- **No telemetry**: No tracking beyond your configured API provider.

## Troubleshooting

### Claude CLI not found

If you encounter `spawn claude ENOENT` or `Claude CLI not found`, the plugin can't auto-detect your Claude installation. Common with Node version managers (nvm, fnm, volta).

**Solution**: Find your CLI path and set it in Settings → Advanced → Claude CLI path.

| Platform | Command | Example Path |
|----------|---------|--------------|
| macOS/Linux | `which claude` | `/Users/you/.volta/bin/claude` |
| Windows (native) | `where.exe claude` | `C:\Users\you\AppData\Local\Claude\claude.exe` |
| Windows (npm) | `npm root -g` | `{root}\@anthropic-ai\claude-code\cli.js` |

> **Note**: On Windows, avoid `.cmd` wrappers. Use `claude.exe` or `cli.js`.

**Alternative**: Add your Node.js bin directory to PATH in Settings → Environment → Custom variables.

**Still having issues?** [Open a GitHub issue](https://github.com/YishenTu/claudian/issues) with your platform, CLI path, and error message.

## Architecture

```
src/
├── main.ts                      # Plugin entry point
├── core/                        # Core infrastructure
│   ├── agent/                   # Claude Agent SDK wrapper (ClaudianService)
│   ├── hooks/                   # PreToolUse/PostToolUse hooks
│   ├── images/                  # Image caching and loading
│   ├── mcp/                     # MCP server config, service, and testing
│   ├── prompts/                 # System prompts for agents
│   ├── sdk/                     # SDK message transformation
│   ├── security/                # Approval, blocklist, path validation
│   ├── storage/                 # Distributed storage system
│   ├── tools/                   # Tool constants and utilities
│   └── types/                   # Type definitions
├── features/                    # Feature modules
│   ├── chat/                    # Main chat view + UI, rendering, controllers
│   ├── inline-edit/             # Inline edit service + UI
│   └── settings/                # Settings tab UI
├── shared/                      # Shared UI components and modals
│   ├── components/              # Input toolbar bits, dropdowns, selection highlight
│   ├── mention/                 # @-mention dropdown controller
│   ├── modals/                  # Approval + instruction modals
│   └── icons.ts                 # Shared SVG icons
├── utils/                       # Modular utility functions
└── style/                       # Modular CSS (→ styles.css)
```

## Roadmap

- [ ] Hooks and other advanced features
- [ ] More to come!

## License

Licensed under the [MIT License](LICENSE).

## Acknowledgments

- [Obsidian](https://obsidian.md) for the plugin API
- [Anthropic](https://anthropic.com) for Claude and the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview)
