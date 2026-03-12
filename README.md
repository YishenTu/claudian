# Geminian

An Obsidian plugin that embeds [Gemini CLI](https://github.com/google-gemini/gemini-cli) as an AI collaborator in your vault. Your vault becomes Gemini's working directory, giving it full agentic capabilities: file read/write, search, bash commands, and multi-step workflows.

> **Based on [Claudian](https://github.com/YishenTu/claudian)** — converted from Claude Code CLI to Gemini CLI. Uses your Google account (no API key needed).

## Features

- **Full Agentic Capabilities**: Leverage Gemini CLI's power to read, write, and edit files, search, and execute bash commands, all within your Obsidian vault.
- **No API Key Required**: Uses Gemini CLI which authenticates with your Google account — works with the free tier (60 req/min, 1000 req/day).
- **Context-Aware**: Automatically attach the focused note, mention files with `@`, exclude notes by tag, include editor selection, and access external directories for additional context.
- **Vision Support**: Analyze images by sending them via drag-and-drop, paste, or file path.
- **Inline Edit**: Edit selected text or insert content at cursor position directly in notes with word-level diff preview.
- **Instruction Mode (`#`)**: Add refined custom instructions to your system prompt directly from the chat input.
- **Slash Commands**: Create reusable prompt templates triggered by `/command`, with argument placeholders and `@file` references.
- **MCP Support**: Connect external tools and data sources via Model Context Protocol servers (stdio, SSE, HTTP).
- **Model Selection**: Choose between Auto, Pro (Gemini 2.5 Pro), Flash (Gemini 2.5 Flash), and Flash Lite models.
- **Plan Mode**: Toggle plan mode via Shift+Tab — Gemini explores and designs before implementing.
- **Security**: Permission modes (YOLO/Safe/Plan), safety blocklist, and vault confinement with symlink-safe checks.
- **10 Languages**: English, Chinese (Simplified/Traditional), Japanese, Korean, Spanish, German, French, Portuguese, Russian.

## Requirements

- [Gemini CLI](https://github.com/google-gemini/gemini-cli) installed
- Obsidian v1.4.5+
- Google account (free tier works)
- Desktop only (macOS, Linux, Windows)

## Installation

### Prerequisites: Install Gemini CLI

```bash
npm install -g @google/gemini-cli
```

Then authenticate:

```bash
gemini
```

Follow the prompts to sign in with your Google account.

### Install the Plugin

#### From Source

1. Clone this repository into your vault's plugins folder:
   ```bash
   cd /path/to/vault/.obsidian/plugins
   git clone https://github.com/Momoyu404/geminian.git
   cd geminian
   ```

2. Install dependencies and build:
   ```bash
   npm install
   npm run build
   ```

3. Enable the plugin in Obsidian:
   - Settings → Community plugins → Enable "Geminian"

#### Manual Install

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/Momoyu404/geminian/releases/latest)
2. Create a folder called `geminian` in your vault's plugins folder:
   ```
   /path/to/vault/.obsidian/plugins/geminian/
   ```
3. Copy the downloaded files into the folder
4. Enable the plugin in Obsidian Settings → Community plugins

### Development

```bash
npm run dev     # Watch mode
npm run build   # Production build
npm run test    # Run tests
npm run lint    # Lint code
```

## Usage

**Two modes:**
1. Click the bot icon in ribbon or use command palette to open chat
2. Select text + hotkey for inline edit

Use it like Gemini CLI — read, write, edit, search files in your vault.

### Context

- **File**: Auto-attaches focused note; type `@` to attach other files
- **Selection**: Select text in editor, then chat — selection included automatically
- **Images**: Drag-drop, paste, or type path
- **External contexts**: Click folder icon in toolbar for access to directories outside vault

### Features

- **Inline Edit**: Select text + hotkey to edit directly in notes
- **Instruction Mode**: Type `#` to add refined instructions to system prompt
- **Slash Commands**: Type `/` for custom prompt templates
- **MCP**: Add external tools via Settings → MCP Servers; use `@mcp-server` in chat to activate

## Configuration

### Settings

**Customization**
- **User name**: Your name for personalized greetings
- **Excluded tags**: Tags that prevent notes from auto-loading
- **Media folder**: Configure where vault stores attachments for embedded image support
- **Custom system prompt**: Additional instructions appended to the default system prompt

**Safety**
- **Enable command blocklist**: Block dangerous bash commands (default: on)
- **Blocked commands**: Patterns to block (supports regex, platform-specific)
- **Allowed export paths**: Paths outside the vault where files can be exported

**Environment**
- **Custom variables**: Environment variables (KEY=VALUE format)
- **Environment snippets**: Save and restore environment variable configurations

**Advanced**
- **Gemini CLI path**: Custom path to Gemini CLI (leave empty for auto-detection)

## Safety and Permissions

| Scope | Access |
|-------|--------|
| **Vault** | Full read/write (symlink-safe via `realpath`) |
| **Export paths** | Write-only (e.g., `~/Desktop`, `~/Downloads`) |
| **External contexts** | Full read/write (session-only) |

- **YOLO mode**: No approval prompts; all tool calls execute automatically (default)
- **Safe mode**: Approval prompt per tool call
- **Plan mode**: Explores and designs a plan before implementing

## Privacy & Data Use

- **Sent to API**: Your input, attached files, images, and tool call outputs go to Google's Gemini API via the CLI.
- **Local storage**: Settings and session metadata stored in `vault/.gemini/`; session data managed by Gemini CLI.
- **No telemetry**: No tracking beyond Google's Gemini API.

## Troubleshooting

### Gemini CLI not found

If you encounter `Gemini CLI not found`, the plugin can't auto-detect your installation.

**Solution**: Find your CLI path and set it in Settings → Advanced → Gemini CLI path.

| Platform | Command | Example Path |
|----------|---------|--------------|
| macOS/Linux | `which gemini` | `/usr/local/bin/gemini` |
| macOS (Homebrew) | `which gemini` | `/opt/homebrew/bin/gemini` |
| Windows | `where.exe gemini` | `C:\Users\you\AppData\Roaming\npm\gemini` |
| npm global | `npm root -g` | `{root}/@google/gemini-cli/gemini.js` |

**Alternative**: Add your Node.js bin directory to PATH in Settings → Environment → Custom variables.

### Authentication Issues

Make sure you've authenticated with Gemini CLI first:

```bash
gemini
```

This will open a browser for Google account login. After signing in, the CLI (and plugin) can use your account.

## Architecture

```
Obsidian Plugin (UI)
      ↓
child_process.spawn("gemini", ["--output-format", "stream-json", ...])
      ↓
Gemini CLI → Google Account (no API key)
```

The plugin spawns the Gemini CLI as a subprocess for each query, passing `--output-format stream-json` to get structured JSONL output. Session continuity is maintained via `--resume`.

```
src/
├── main.ts                      # Plugin entry point
├── core/                        # Core infrastructure
│   ├── agent/                   # Gemini CLI wrapper (GeminianService)
│   ├── agents/                  # Custom agent management
│   ├── commands/                # Slash command management
│   ├── hooks/                   # PreToolUse hooks
│   ├── mcp/                     # MCP server config and management
│   ├── prompts/                 # System prompts
│   ├── sdk/                     # Gemini JSONL event transformation
│   ├── security/                # Approval, blocklist, path validation
│   ├── storage/                 # Settings and session storage
│   └── types/                   # Type definitions
├── features/                    # Feature modules
│   ├── chat/                    # Main chat view + UI
│   ├── inline-edit/             # Inline edit service + UI
│   └── settings/                # Settings tab UI
├── shared/                      # Shared UI components
├── i18n/                        # Internationalization (10 locales)
├── utils/                       # Utility functions
└── style/                       # CSS styles
```

## Credits

- Based on [Claudian](https://github.com/YishenTu/claudian) by Yishen Tu
- [Obsidian](https://obsidian.md) for the plugin API
- [Google Gemini CLI](https://github.com/google-gemini/gemini-cli) for the agentic CLI

## License

Licensed under the [MIT License](LICENSE).
