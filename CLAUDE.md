# CLAUDE.md

## Project Overview

Claudian - An Obsidian plugin that embeds Claude Code as a sidebar chat interface. The vault directory becomes Claude's working directory, giving it full agentic capabilities: file read/write, bash commands, and multi-step workflows.

## Architecture

```
src/
├── main.ts                      # Plugin entry point
├── core/                        # Core infrastructure (no feature dependencies)
│   ├── agent/                   # Claude Agent SDK wrapper
│   │   ├── ClaudianService.ts
│   │   └── SessionManager.ts
│   ├── agents/                  # Custom agent management
│   │   ├── AgentManager.ts
│   │   └── AgentStorage.ts
│   ├── commands/                # Slash command management
│   │   ├── SlashCommandManager.ts
│   │   └── builtInCommands.ts
│   ├── hooks/                   # PreToolUse/PostToolUse hooks
│   ├── images/                  # Image caching and loading
│   ├── mcp/                     # MCP server config, service, and testing
│   │   ├── McpServerManager.ts
│   │   ├── McpService.ts
│   │   └── McpTester.ts
│   ├── plugins/                 # Claude Code plugin discovery and management
│   │   ├── PluginManager.ts
│   │   └── PluginStorage.ts
│   ├── prompts/                 # System prompts for agents
│   ├── sdk/                     # SDK message transformation
│   ├── security/                # Approval, blocklist, path validation
│   ├── storage/                 # Distributed storage system
│   ├── tools/                   # Tool constants and utilities
│   └── types/                   # Type definitions
├── features/                    # Feature modules
│   ├── chat/                    # Main chat interface
│   │   ├── ClaudianView.ts      # Thin shell: lifecycle + assembly
│   │   ├── constants.ts         # FLAVOR_TEXTS, LOGO_SVG
│   │   ├── state/               # Centralized state (ChatState)
│   │   ├── controllers/         # ConversationController, StreamController, InputController, SelectionController
│   │   ├── rendering/           # MessageRenderer and render helpers
│   │   ├── services/            # TitleGenerationService, AsyncSubagentManager, InstructionRefineService
│   │   ├── tabs/                # Multi-tab infrastructure (Tab, TabManager, TabBar)
│   │   └── ui/                  # Chat UI components (toolbar, file context, panels)
│   ├── inline-edit/             # Inline edit feature
│   │   ├── InlineEditService.ts
│   │   └── ui/                  # Inline edit modal
│   └── settings/                # Settings tab
│       ├── ClaudianSettings.ts
│       └── ui/                  # Settings UI components
├── shared/                      # Shared UI components and modals
│   ├── components/              # Dropdowns, selection highlight
│   ├── mention/                 # @-mention dropdown controller
│   ├── modals/                  # Approval + instruction modals
│   └── icons.ts                 # Shared SVG icons
├── i18n/                        # Internationalization
│   └── locales/                 # Language files (en, de, es, fr, ja, ko, pt, ru, zh-CN, zh-TW)
├── utils/                       # Modular utility functions
└── style/                       # Modular CSS (→ styles.css)
```

| Layer | Folder | Purpose |
|-------|--------|---------|
| **core** | `agent/` | Claude Agent SDK wrapper (ClaudianService, SessionManager) |
| | `agents/` | Custom agent discovery and management (AgentManager, AgentStorage) |
| | `commands/` | Slash command expansion (SlashCommandManager, builtInCommands) |
| | `hooks/` | Security and diff tracking hooks |
| | `images/` | Image caching with SHA-256 dedup |
| | `mcp/` | MCP server config, service, and testing |
| | `plugins/` | Claude Code plugin discovery, management, and command loading |
| | `prompts/` | System prompts (main agent, inline edit, instruction refine, title generation) |
| | `sdk/` | SDK message transformation |
| | `security/` | Approval, blocklist, path validation |
| | `storage/` | Settings, commands, sessions, MCP storage (Claude Code pattern) |
| | `tools/` | Tool names, icons, input parsing |
| | `types/` | Type definitions (includes MCP, plugin, and agent types) |
| **features** | `chat/` | Main chat view with modular controllers |
| | `chat/state/` | Centralized chat state management (ChatState) |
| | `chat/controllers/` | Conversation, Stream, Input, Selection controllers |
| | `chat/rendering/` | Message DOM rendering (MessageRenderer) |
| | `chat/services/` | TitleGenerationService, AsyncSubagentManager, InstructionRefineService |
| | `chat/tabs/` | Multi-tab infrastructure (Tab, TabManager, TabBar, types) |
| | `chat/ui/` | Chat UI components (toolbar, file context, panels) |
| | `inline-edit/` | Inline edit service |
| | `inline-edit/ui/` | Inline edit modal UI |
| | `settings/` | Settings tab logic |
| | `settings/ui/` | Settings UI components |
| **shared** | `components/` | Dropdowns, selection highlight |
| | `mention/` | @-mention dropdown controller |
| | `modals/` | Approval + instruction modals |
| | `icons.ts` | Shared SVG icons |
| **i18n** | | Internationalization with 10 locales |
| **utils** | | Modular utilities: date, path, env, context, editor, session, sdkSession, markdown, mcp, slashCommand |
| **style** | | Modular CSS (built into root `styles.css`) |

## Commands

```bash
npm run dev       # Development (watch mode)
npm run build     # Production build
npm run typecheck # Type check
npm run lint      # Lint code
npm run test      # Run tests
```

## Tests

- Tests are split into `unit` and `integration`, mirroring the `src/` structure.
- Coverage focuses on `unit`; `integration` targets key component flows.
- E2E tests are intentionally out of scope for now.

```
tests/
  __mocks__/
  unit/
    core/
    features/
    i18n/
    shared/
    utils/
  integration/
    core/
    features/
    main.test.ts
```

```bash
npm run test -- --selectProjects unit        # Run unit tests
npm run test -- --selectProjects integration # Run integration tests
npm run test:coverage -- --selectProjects unit # Unit coverage
```

## Key Patterns

### Claude Agent SDK
```typescript
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';

const options: Options = {
  cwd: vaultPath,
  permissionMode: 'bypassPermissions',
  allowDangerouslySkipPermissions: true,
  model: settings.model,
  abortController: this.abortController,
  pathToClaudeCodeExecutable: '/path/to/claude',
  resume: sessionId,
  maxThinkingTokens: budgetConfig.tokens, // Optional extended thinking
};

const response = query({ prompt, options });
for await (const message of response) { /* Handle streaming */ }
```

### Obsidian Basics
```typescript
// View registration
this.registerView(VIEW_TYPE_CLAUDIAN, (leaf) => new ClaudianView(leaf, this));

// Vault path
const vaultPath = this.app.vault.adapter.basePath;

// Markdown rendering
await MarkdownRenderer.renderMarkdown(markdown, container, sourcePath, component);
```

### Slash Commands
- Expanded by `SlashCommandManager` in chat and inline edit
- Supports: YAML frontmatter, `$ARGUMENTS`/`$N` placeholders, `@file` references, inline bash `` !`command` ``
- Order: placeholders → inline bash → file references
- Command overrides: `model`, `allowedTools`

### Diff Tracking
- Pre/Post hooks capture content by `tool_use_id` (100KB cap)
- `WriteEditRenderer` + `DiffRenderer` for hunked inline diffs

## SDK Message Types

| Type | Description |
|------|-------------|
| `system` | Session init (subtype: 'init'), status |
| `assistant` | Content blocks: `thinking`, `text`, `tool_use` |
| `user` | User messages, `tool_use_result` |
| `stream_event` | Streaming deltas |
| `result` | Completion |
| `error` | Errors |

## Available Tools

| Category | Tools |
|----------|-------|
| File | `Read`, `Write`, `Edit`, `Glob`, `Grep`, `LS`, `NotebookEdit` |
| Shell | `Bash`, `BashOutput`, `KillShell` |
| Web | `WebSearch`, `WebFetch` |
| Task | `Task`, `TodoWrite` |
| Skills | `Skill` |


## Settings

```typescript
interface ClaudianSettings {
  model: string;                     // 'claude-haiku-4-5' | 'claude-sonnet-4-5' | 'claude-opus-4-5' | custom
  titleGenerationModel: string;      // Model for auto titles (empty = auto)
  thinkingBudget: 'off' | 'low' | 'medium' | 'high' | 'xhigh';  // 0 | 4k | 8k | 16k | 32k tokens
  permissionMode: 'yolo' | 'normal';
  enableBlocklist: boolean;
  blockedCommands: { unix: string[], windows: string[] };  // Platform-keyed blocklist
  permissions: Permission[];         // Tool approvals (like Claude Code)
  excludedTags: string[];            // Tags to exclude from auto-context
  mediaFolder: string;               // Attachment folder for ![[images]]
  environmentVariables: string;      // KEY=VALUE format
  envSnippets: EnvSnippet[];
  systemPrompt: string;
  allowedExportPaths: string[];      // Write-only paths outside vault
  slashCommands: SlashCommand[];     // Loaded from .claude/commands/*.md + enabled plugins
  keyboardNavigation: {             // Vim-style navigation key bindings
    scrollUpKey: string;
    scrollDownKey: string;
    focusInputKey: string;
  };
  claudeCliPath: string;             // Custom Claude CLI path (empty = auto-detect)
  enabledPlugins: string[];          // IDs of enabled Claude Code plugins (per vault)
  maxTabs: number;                   // Maximum concurrent tabs (3-10, default: 3)
  show1MModel: boolean;              // Show 1M context model in selector (default: false)
}

// Per-conversation state (session-only, not global settings)
interface Conversation {
  // ... other fields ...
  externalContextPaths?: string[];   // External directories with full access (resets on session switch)
}
```

## Storage System

Hybrid storage using SDK-native sessions with metadata overlay:

```
~/.claude/projects/{encoded-vault}/     # SDK-native message storage
└── {sessionId}.jsonl                   # SDK session messages (new conversations)

vault/.claude/
├── settings.json              # User settings + permissions (shareable)
├── mcp.json                   # MCP server configurations
├── agents/                    # Vault-specific custom agents
│   └── {name}.md              # YAML frontmatter + system prompt
├── commands/                  # Slash commands as Markdown
│   └── {name}.md              # YAML frontmatter + prompt content
└── sessions/                  # Session metadata + legacy storage
    ├── {id}.meta.json         # Metadata overlay for SDK-native sessions
    └── {id}.jsonl             # Legacy sessions (full messages, backward compat)

.obsidian/plugins/claudian/
└── data.json                  # Machine state only (tabManagerState, etc.)
```

| File | Contents |
|------|----------|
| `~/.claude/projects/.../*.jsonl` | SDK-native session messages (new conversations) |
| `settings.json` | All settings including `permissions` (like Claude Code) |
| `mcp.json` | MCP server configs with `_claudian` metadata (Claude Code compatible) |
| `commands/*.md` | Slash commands with YAML frontmatter |
| `sessions/*.meta.json` | Metadata overlay for SDK-native sessions (title, usage, UI state) |
| `sessions/*.jsonl` | Legacy sessions (meta + messages per line, backward compat) |
| `data.json` | `tabManagerState`, other machine-only state |

**Storage modes**:
- **SDK-native** (new conversations): Messages in `~/.claude/projects/`, metadata in `.meta.json`
- **Legacy** (existing conversations): Full JSONL in `sessions/`, continues to work

**Vault path encoding**: All non-alphanumeric characters → `-` (matches SDK behavior)

**Command ID encoding**: `-` → `-_`, `/` → `--` (reversible, no collisions)

## Models & Thinking

| Model | Default Thinking |
|-------|------------------|
| `claude-haiku-4-5` | Off |
| `claude-sonnet-4-5` | Low (4k) |
| `claude-sonnet-4-5-1m` | Low (4k) |
| `claude-opus-4-5` | Medium (8k) |

**1M Context Model**: `claude-sonnet-4-5-1m` provides 1M token context window. Requires Max subscription. Enable via `show1MModel` setting (hidden by default). Uses `context-1m-2025-08-07` beta flag.

Custom models via env vars: `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_*_MODEL`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`

## Features

### Multi-Tab Support
Run multiple concurrent chat sessions in the sidebar.
- **Independent streaming**: Each tab has its own ClaudianService instance
- **Lazy initialization**: Services only start when tab is first used (on first query)
- **Tab limit**: Configurable 3-10 tabs via settings (`maxTabs`)
- **Persistence**: Tab state saved to `data.json` and restored on reload
- **Tab bar**: Badges show tab index, streaming status, and attention indicators
- **Hotkeys**: `Cmd/Ctrl+1-9` to switch tabs, `Cmd/Ctrl+W` to close

### Smart Scrolling
Intelligent scroll behavior during streaming responses.
- **Auto-scroll**: Automatically scrolls to bottom during streaming
- **User override**: Scrolling up disables auto-scroll; scrolling back to bottom re-enables it
- **Scroll-to-bottom button**: Sticky button appears when scrolled up, click to jump to bottom and re-enable auto-scroll
- **Reset on query**: Auto-scroll resets to enabled when sending a new message

### Image Support
- Drag/drop or paste images into the chat input
- Formats: JPEG, PNG, GIF, WebP (max 5MB)
- Typed image paths (for example `![[image.png]]` or `./image.png`) stay as text and are not auto-attached

### Media Folder
Configure `mediaFolder` setting so agent can read `![[image.jpg]]` embeds.

### Instruction Mode (`#`)
Type `#` at start → refine instruction → accept to append to system prompt.

### Selection Awareness
Main chat agent is aware of editor selection:
- Polls editor selection every 250ms
- Shows "X lines selected" indicator in input area
- Preserves visual highlight when focus moves to input (CM6 decoration)
- Selection sent as `<editor_selection>` XML tag in prompt
- System prompt "## Editor Selection" section conditionally included

### Inline Edit
Select text or place cursor + hotkey → edit/insert without sidebar chat.
- Read-only tools: `Read`, `Grep`, `Glob`, `LS`, `WebSearch`, `WebFetch`
- Selection mode: `<replacement>` tags
- Cursor mode: `<insertion>` tags

### Skills
Reusable capability modules that Claude discovers and invokes automatically based on context.
- **User skills**: `~/.claude/skills/{name}/SKILL.md` (all vaults)
- **Project skills**: `{vault}/.claude/skills/{name}/SKILL.md` (vault-specific)
- Compatible with [Claude Code skill format](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)

### Custom Agents (Subagents)
Define custom subagents that Claude can invoke via the SDK's native `Task` tool.
- **Agent files**: Markdown with YAML frontmatter (matches Claude Code format)
- **Loading order** (earlier sources take precedence for duplicate IDs):
  1. **Built-in agents**: SDK-provided (Explore, Plan, Bash, general-purpose)
  2. **Plugin agents**: `{pluginPath}/agents/*.md` (namespaced as `plugin-name:agent-name`)
  3. **Vault agents**: `{vaultPath}/.claude/agents/*.md`
  4. **Global agents**: `~/.claude/agents/*.md`
- **@-mention**: Type `@Agents/` to select custom agents in chat input
- **SDK integration**: Custom agents passed to `Options.agents` (built-ins filtered out)

**Agent file format**:
```markdown
---
name: My Agent
description: When to use this agent
tools: Read, Grep, Glob          # Optional: comma-separated or YAML array
disallowedTools: Bash, Write     # Optional: tools to exclude
model: sonnet                    # Optional: sonnet | opus | haiku | inherit (default)
---

System prompt for the agent goes here.
```

**Storage**:
```
~/.claude/agents/              # Global agents (all vaults)
{vault}/.claude/agents/        # Vault-specific agents
{pluginPath}/agents/           # Plugin agents (namespaced)
```

### @-Mention Dropdown
Type `@` in the input to open the mention dropdown for attaching context.
- **Agents folder**: `@Agents/` shows available custom agents for selection
- **MCP servers**: `@server-name` enables context-saving MCP servers (persisted per-conversation)
- **External contexts**: `@folder/` filters to files from that external context (session-only, added via folder icon)
- **Context files**: Only shown after `@folder/` filter, displays filename with folder badge
- **Vault files**: Markdown files from the vault, shown by default

**Current note chip**: Only the focused note is shown as a chip. It is sent once per session as `<current_note>` and stored on the conversation. `@` mentions stay in the query text (no chips).

**Persisted per-conversation**: MCP server selections are saved with each conversation and restored when switching back.

**Session-only state**: External contexts reset when switching conversations or creating new ones.

**Dropdown order**: MCP servers → Agents folder → External contexts → Vault files

**Example flow**:
```
@           → [@Agents/] [@workspace/] [note.md] [note2.md] ...
@Agents/    → [my-agent] [plugin:agent] ...  (custom agents)
@workspace/ → [file1.ts] [file2.ts] ...  (files from external context)
```

### MCP (Model Context Protocol)
Extend Claude with external tools and data sources via MCP servers.
- **Server types**: `stdio` (local command), `sse` (Server-Sent Events), `http` (HTTP endpoint)
- **Storage**: `.claude/mcp.json` (Claude Code compatible with `_claudian` metadata)
- **Context-saving mode**: Hide server tools unless `@`-mentioned (saves context window)
- **UI**: Settings page for add/edit/delete, connection tester, toolbar selector with glow effect

### Claude Code Plugins
Discover and enable Claude Code plugins installed via the CLI.
- **Registry**: Reads from `~/.claude/plugins/installed_plugins.json`
- **Scopes**:
  - **User scope**: `projectPath` = home directory → available in all vaults
  - **Project scope**: `projectPath` = specific directory → only in matching vault
- **Features supported**: Skills, slash commands (namespaced as `plugin-name:command`)
- **Settings UI**: Enable/disable toggle per plugin, grouped by scope
- **Manifest formats**: Single-plugin (`plugin.json`) and marketplace (`marketplace.json`)

**Plugin commands**: Commands from enabled plugins are automatically loaded from `{installPath}/commands/*.md` and namespaced with the plugin name. Example: A plugin "Code Review" with `commands/pr.md` becomes `/code-review:pr`.

### Context Window Usage
240° arc gauge showing context usage in the input toolbar.
- **Location**: Between thinking selector and folder icon
- **Data**: `contextTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens`
- **Tooltip**: Hover shows "45k / 200k" (tokens used / context window)
- **Persistence**: Saved to session JSONL, restored on conversation switch
- **Updates**: After each completed agent response (from SDK `result` message)



### Auto Title Generation
AI-powered conversation titles generated from the first user message.
- **Trigger**: After first user message is sent
- **Model**: Configurable via `titleGenerationModel` setting, falls back to `ANTHROPIC_DEFAULT_HAIKU_MODEL` env var, then `claude-haiku-4-5`
- **Concurrent**: Each conversation has its own AbortController; multiple can generate simultaneously
- **UI**: Loading spinner while generating, refresh icon if failed (click to retry)
- **Constraints**: Max 50 characters, no quotes/punctuation, sentence case
- **Manual override**: User rename takes precedence; generation stops if renamed during progress
- **Status tracking**: `titleGenerationStatus` field: `pending` | `success` | `failed`

## Security

| Mode | Description |
|------|-------------|
| YOLO | Bypass approvals (default) |
| Safe | Require approval per action |

**Restrictions (both modes)**:
- Vault-only file access by default (symlink-safe via `realpath`)
- Blocked commands: Platform-detected defaults
  - Unix: `rm -rf`, `chmod 777`, `chmod -R 777`
  - Windows CMD: `del /s /q`, `rd /s /q`, `rmdir /s /q`, `format`, `diskpart`
  - Windows PowerShell: `Remove-Item` variants, `ri`/`rm`/`del`/`erase` aliases with `-Recurse`/`-Force`, `Format-Volume`, `Clear-Disk`, `Initialize-Disk`, `Remove-Partition`
  - On Windows, both Unix and Windows blocklists are merged (Git Bash can invoke both)
- Export paths: Write-only to configured paths (default: `~/Desktop`, `~/Downloads`)
- External contexts: Session-only full access to paths outside vault (folder icon in input toolbar, resets on session switch)

## Cross-Platform Support

The plugin supports macOS, Linux, and Windows:

| Feature | Unix | Windows |
|---------|------|---------|
| Home paths | `~/path` | `~/path`, `~\path` |
| Env vars | `$VAR`, `${VAR}` | `%VAR%`, `$VAR`, `${VAR}` |
| Path separators | `/` | `/`, `\` (normalized internally) |
| CLI detection | `/usr/local/bin`, `~/.local/bin`, etc. | `%LOCALAPPDATA%\Claude`, `%APPDATA%\npm`, etc. |
| Blocked commands | Unix commands | Unix + Windows commands (merged) |
| MSYS paths | N/A | `/c/Users/...` → `C:\Users\...` |

Environment variable expansion is case-insensitive on Windows.

## CSS Structure

CSS is modularized in `src/style/` and built into root `styles.css`:

```
src/style/
├── base/           # container, animations (@keyframes)
├── components/     # header, history, messages, code, thinking, toolcalls, todo, subagent, input, context-footer (meter)
├── toolbar/        # model-selector, thinking-selector, permission-toggle, external-context, mcp-selector
├── features/       # file-context, image-context, image-modal, inline-edit, diff, slash-commands
├── modals/         # approval, instruction, mcp-modal
├── settings/       # base, approved-actions, env-snippets, slash-settings, mcp-settings, plugin-settings
├── accessibility.css
└── index.css       # Build order (@import list)
```

When adding new CSS modules, register them in `src/style/index.css` via `@import` or the build will omit them.

All classes use `.claudian-` prefix. Key patterns:

| Pattern | Examples |
|---------|----------|
| Layout | `-container`, `-header`, `-messages`, `-input` |
| Messages | `-message`, `-message-user`, `-message-assistant` |
| Tool calls | `-tool-call`, `-tool-header`, `-tool-content`, `-tool-status` |
| Thinking | `-thinking-block`, `-thinking-header`, `-thinking-content` |
| Todo | `-todo-list`, `-todo-item`, `-todo-pending`, `-todo-completed` |
| Subagent | `-subagent-list`, `-subagent-header`, `-subagent-content` |
| File context | `-file-chip`, `-mention-dropdown` |
| Images | `-image-preview`, `-image-chip`, `-drop-overlay` |
| Inline edit | `-inline-input`, `-inline-diff-replace`, `-diff-del`, `-diff-ins` |
| Selection | `-selection-indicator`, `-selection-highlight` |
| External context | `-external-context-selector`, `-external-context-icon`, `-external-context-dropdown` |
| Context meter | `-context-meter`, `-context-meter-gauge`, `-context-meter-percent`, `-meter-bg`, `-meter-fill` |
| MCP | `-mcp-selector`, `-mcp-selector-icon`, `-mcp-selector-dropdown`, `-mcp-item` |
| MCP Settings | `-mcp-header`, `-mcp-list`, `-mcp-status`, `-mcp-test-modal` |
| Plugin Settings | `-plugin-header`, `-plugin-list`, `-plugin-item`, `-plugin-status`, `-plugin-scope-badge` |
| Modals | `-approval-modal`, `-instruction-modal`, `-mcp-modal` |

## Development Notes

- Test Driven Development
- Generated docs go in `dev/`
- Generated agents communication notes in `.agents/`
- Run `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build` after editing
- Do not use console msg in production code, only add them upon request from user, and remove them before commit. 
- If user should be notified/warned about something, use the notification system provided by Obsidian, do not use console msg.
