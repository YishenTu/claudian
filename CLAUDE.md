# CLAUDE.md

## Project Overview

Claudian - An Obsidian plugin that embeds Claude Code as a sidebar chat interface. The vault directory becomes Claude's working directory, giving it full agentic capabilities: file read/write, bash commands, and multi-step workflows.

## Architecture

```
src/
├── main.ts                      # Plugin entry point
├── core/                        # Core infrastructure (no feature dependencies)
│   ├── agent/                   # Claude Agent SDK wrapper
│   │   └── ClaudianService.ts
│   ├── hooks/                   # PreToolUse/PostToolUse hooks
│   ├── images/                  # Image caching and loading
│   ├── mcp/                     # MCP server config management
│   │   └── McpServerManager.ts
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
│   │   ├── rendering/           # MessageRenderer
│   │   └── services/            # TitleGenerationService, AsyncSubagentManager, InstructionRefineService
│   ├── inline-edit/             # Inline edit feature
│   ├── mcp/                     # MCP @-mention detection and UI helpers
│   │   ├── McpService.ts
│   │   └── McpTester.ts
│   └── settings/                # Settings tab
├── ui/                          # UI components
│   ├── components/              # Reusable UI components
│   ├── modals/                  # Modal dialogs
│   ├── renderers/               # Content renderers
│   └── settings/                # Settings UI components
├── utils/                       # Modular utility functions
└── style/                       # Modular CSS (→ styles.css)
```

| Layer | Folder | Purpose |
|-------|--------|---------|
| **core** | `agent/` | Claude Agent SDK wrapper (ClaudianService) |
| | `hooks/` | Security and diff tracking hooks |
| | `images/` | Image caching with SHA-256 dedup |
| | `mcp/` | MCP server config loading and filtering (McpServerManager) |
| | `prompts/` | System prompts (main agent, inline edit, instruction refine, title generation) |
| | `sdk/` | SDK message transformation |
| | `security/` | Approval, blocklist, path validation |
| | `storage/` | Settings, commands, sessions, MCP storage (Claude Code pattern) |
| | `tools/` | Tool names, icons, input parsing |
| | `types/` | Type definitions (includes MCP types) |
| **features** | `chat/` | Main chat view with modular controllers |
| | `chat/state/` | Centralized chat state management (ChatState) |
| | `chat/controllers/` | Conversation, Stream, Input, Selection controllers |
| | `chat/rendering/` | Message DOM rendering (MessageRenderer) |
| | `chat/services/` | TitleGenerationService, AsyncSubagentManager, InstructionRefineService |
| | `inline-edit/` | Inline edit service |
| | `mcp/` | MCP @-mention detection, UI helpers, connection testing |
| | `settings/` | Settings tab UI |
| **ui** | `components/` | Input toolbar (with context meter), file/image context, slash command dropdown, AskUserQuestion panel, PlanBanner, PlanApprovalPanel |
| | `modals/` | Approval, inline edit, instruction, MCP modals |
| | `renderers/` | Thinking blocks, tool calls, todo lists, subagents, diffs, AskUserQuestion |
| | `settings/` | Env snippets, MCP settings, slash command settings |
| **utils** | | Modular utilities: date, path, env, context, editor, session, markdown, mcp, slashCommand |
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
    ui/
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
| Plan | `EnterPlanMode`, `ExitPlanMode` (internal, hidden from UI) |

## Settings

```typescript
interface ClaudianSettings {
  model: string;                     // 'claude-haiku-4-5' | 'claude-sonnet-4-5' | 'claude-opus-4-5' | custom
  titleGenerationModel: string;      // Model for auto titles (empty = auto)
  thinkingBudget: 'off' | 'low' | 'medium' | 'high';  // 0 | 4k | 8k | 16k tokens
  permissionMode: 'yolo' | 'normal';
  enableBlocklist: boolean;
  blockedCommands: { unix: string[], windows: string[] };  // Platform-keyed blocklist
  showToolUse: boolean;
  toolCallExpandedByDefault: boolean;
  permissions: Permission[];         // Tool approvals (like Claude Code)
  excludedTags: string[];            // Tags to exclude from auto-context
  mediaFolder: string;               // Attachment folder for ![[images]]
  environmentVariables: string;      // KEY=VALUE format
  envSnippets: EnvSnippet[];
  systemPrompt: string;
  allowedExportPaths: string[];      // Write-only paths outside vault
  allowedContextPaths: string[];     // Read-only paths outside vault
  slashCommands: SlashCommand[];     // Loaded from .claude/commands/*.md
}
```

## Storage System

Distributed storage mimicking Claude Code patterns:

```
vault/.claude/
├── settings.json              # User settings + permissions (shareable)
├── mcp.json                   # MCP server configurations
├── commands/                  # Slash commands as Markdown
│   └── {name}.md              # YAML frontmatter + prompt content
└── sessions/                  # Chat sessions as JSONL
    └── {conv-id}.jsonl        # Meta line + message lines

.obsidian/plugins/claudian/
└── data.json                  # Machine state only
```

| File | Contents |
|------|----------|
| `settings.json` | All settings including `permissions` (like Claude Code) |
| `mcp.json` | MCP server configs with `_claudian` metadata (Claude Code compatible) |
| `commands/*.md` | Slash commands with YAML frontmatter |
| `sessions/*.jsonl` | Conversations (meta + messages per line) |
| `data.json` | `activeConversationId`, `lastEnvHash`, model tracking |

**Command ID encoding**: `-` → `-_`, `/` → `--` (reversible, no collisions)

## Models & Thinking

| Model | Default Thinking |
|-------|------------------|
| `claude-haiku-4-5` | Off |
| `claude-sonnet-4-5` | Low (4k) |
| `claude-opus-4-5` | Medium (8k) |

Custom models via env vars: `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_*_MODEL`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`

## Features

### Image Support
- Drag/drop, paste, or path in message (`./image.png`)
- Formats: JPEG, PNG, GIF, WebP (max 5MB)
- Auto-detects quoted, relative, and absolute paths

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

### MCP (Model Context Protocol)
Extend Claude with external tools and data sources via MCP servers.
- **Server types**: `stdio` (local command), `sse` (Server-Sent Events), `http` (HTTP endpoint)
- **Storage**: `.claude/mcp.json` (Claude Code compatible with `_claudian` metadata)
- **Context-saving mode**: Hide server tools unless `@`-mentioned (saves context window)
- **UI**: Settings page for add/edit/delete, connection tester, toolbar selector with glow effect
- **@-mention**: Type `@server-name` to enable context-saving servers in a message

### Context Window Usage
240° arc gauge showing context usage in the input toolbar.
- **Location**: Between thinking selector and folder icon
- **Data**: `contextTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens`
- **Tooltip**: Hover shows "45k / 200k" (tokens used / context window)
- **Persistence**: Saved to session JSONL, restored on conversation switch
- **Updates**: After each completed agent response (from SDK `result` message)

### Plan Mode
Read-only exploration mode with approval flow before implementation.
- **Toggle**: `Shift+Tab` in input area toggles plan mode on/off
- **Indicator**: Teal "Plan" badge next to YOLO/Safe toggle when active
- **SDK**: `permissionMode: 'plan'` enforces read-only tools
- **Tools**: `Read`, `Glob`, `Grep`, `LS`, `WebSearch`, `WebFetch`, `EnterPlanMode`, `ExitPlanMode`
- **Plan file**: Written to `~/.claude/plans/` with tilde expansion
- **Approval panel**: Approve / Approve + New Session / Revise options
- **Implementation**: Approved plan appended to system prompt, auto-sends hidden implementation prompt
- **UI components**: `PlanBanner` (teal indicator), `PlanApprovalPanel` (approval/revise flow)

### Auto Title Generation
AI-powered conversation titles generated after first exchange.
- **Trigger**: After first user message and assistant response complete
- **Model**: Configurable via `titleGenerationModel` setting, falls back to `ANTHROPIC_DEFAULT_HAIKU_MODEL` env var, then `claude-haiku-4-5`
- **Concurrent**: Each conversation has its own AbortController; multiple can generate simultaneously
- **UI**: Loading spinner while generating, refresh icon if failed (click to retry)
- **Constraints**: Max 50 characters, no quotes/punctuation, sentence case
- **Plan prefix**: Plan conversations preserve `[Plan]` prefix
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
- Context paths: Read-only access to configured paths outside vault (folder icon in input toolbar)

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
├── components/     # header, history, messages, code, thinking, toolcalls, todo, subagent, input, ask-user-question, context-footer (meter), plan-banner, plan-approval
├── toolbar/        # model-selector, thinking-selector, permission-toggle, context-path, mcp-selector
├── features/       # file-context, image-context, image-modal, inline-edit, diff, slash-commands
├── modals/         # approval, instruction, mcp-modal
├── settings/       # base, approved-actions, env-snippets, slash-settings, mcp-settings
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
| Context paths | `-context-path-selector`, `-context-path-icon`, `-context-path-dropdown` |
| Context meter | `-context-meter`, `-context-meter-gauge`, `-context-meter-percent`, `-meter-bg`, `-meter-fill` |
| MCP | `-mcp-selector`, `-mcp-selector-icon`, `-mcp-selector-dropdown`, `-mcp-item` |
| MCP Settings | `-mcp-header`, `-mcp-list`, `-mcp-status`, `-mcp-test-modal` |
| AskUserQuestion | `-ask-panel`, `-ask-question-block`, `-ask-question-tree`, `-ask-question-q`, `-ask-question-a` |
| Plan mode | `-plan-banner`, `-plan-approval-panel`, `-plan-approval-actions`, `-plan-badge` |
| Modals | `-approval-modal`, `-instruction-modal`, `-mcp-modal` |

## Development Notes

- Test Driven Development
- Generated docs go in `dev/`
- Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test` after editing
