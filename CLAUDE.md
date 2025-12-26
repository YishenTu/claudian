# CLAUDE.md

## Project Overview

Claudian - An Obsidian plugin that embeds Claude Code as a sidebar chat interface. The vault directory becomes Claude's working directory, giving it full agentic capabilities: file read/write, bash commands, and multi-step workflows.

## Architecture

```
src/
├── main.ts              # Plugin entry point
├── ClaudianView.ts      # Sidebar chat UI (ItemView)
├── ClaudianService.ts   # Claude Agent SDK wrapper
├── ClaudianSettings.ts  # Settings tab
├── utils.ts             # Vault, env, session utilities
├── services/            # Agent services and subagent state
│   ├── AsyncSubagentManager.ts # Async subagent state machine
│   ├── InlineEditService.ts # Inline text editing service
│   └── InstructionRefineService.ts # Instruction refinement service
├── system-prompt/       # System prompts for different agents
├── sdk/                 # SDK message transformation
├── hooks/               # PreToolUse/PostToolUse hooks
├── security/            # Approval, blocklist, path validation
├── tools/               # Tool constants and utilities
├── images/              # Image caching and loading
├── storage/             # Distributed storage system
├── types/               # Type definitions
└── ui/                  # All UI components
```

| Folder | Purpose |
|--------|---------|
| `system-prompt/` | System prompts (main agent, inline edit, instruction refine) |
| `sdk/` | SDK message transformation |
| `hooks/` | Security and diff tracking hooks |
| `security/` | Approval, blocklist, path validation |
| `tools/` | Tool names, icons, input parsing |
| `images/` | Image caching with SHA-256 dedup |
| `storage/` | Settings, commands, sessions storage (Claude Code pattern) |
| `services/` | Agent services and subagent state |
| `types/` | Type definitions |
| `ui/` | All UI components |

## Commands

```bash
npm run dev      # Development (watch mode)
npm run build    # Production build
npm run lint     # Lint code
npm run test     # Run tests
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
  - Windows PowerShell: `Remove-Item -Recurse -Force`, `Format-Volume`, `Clear-Disk`
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
| Blocked commands | Unix commands | Windows commands |

Environment variable expansion is case-insensitive on Windows.

## CSS Classes

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
| Modals | `-approval-modal`, `-instruction-modal` |

## Development Notes

- Test Driven Development
- Generated docs go in `dev/`
- Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test` after editing

## Dependencies

- Claude Code CLI (SDK uses internally)
- Obsidian v1.0.0+
