# CLAUDE.md

## Project Overview

Claudian - An Obsidian plugin that embeds Claude Code as a sidebar chat interface. The vault directory becomes Claude's working directory, giving it full agentic capabilities: file read/write, bash commands, and multi-step workflows.

**Core Principle**: "Claude Code in a sidebar" - the full Claude Code experience embedded in Obsidian.

## Architecture

```
src/
├── main.ts              # Plugin entry point, registers view and settings
├── ClaudianView.ts      # Sidebar chat UI (ItemView), orchestrates UI components
├── ClaudianService.ts   # Claude Agent SDK wrapper, transforms SDK messages
├── ClaudianSettings.ts  # Settings tab
├── systemPrompt.ts      # System prompt and image handling instructions
├── types.ts             # Shared type definitions (StreamChunk, ToolCallInfo, etc.)
├── utils.ts             # Utility functions (getVaultPath, env var parsing, model detection)
├── AsyncSubagentManager.ts # Async subagent state machine (Task → AgentOutputTool)
├── InlineEditService.ts # Lightweight Claude query service for inline text editing
├── ui/DiffRenderer.ts   # Diff utilities (LCS, hunking, render helpers)
├── ui/WriteEditRenderer.ts # Subagent-style Write/Edit diff blocks
└── ui/                  # Modular UI components
    ├── index.ts              # Barrel export for all UI components
    ├── ApprovalModal.ts      # Permission approval dialog (Modal)
    ├── InputToolbar.ts       # Model selector, thinking budget, permission toggle
    ├── FileContext.ts        # File attachments, @mentions, edited files tracking
    ├── ImageContext.ts       # Image attachments, drag/drop, paste, path detection
    ├── SlashCommandManager.ts # Slash command detection and expansion
    ├── SlashCommandDropdown.ts # Slash command dropdown UI
    ├── SlashCommandSettings.ts # Slash command settings UI
    ├── ToolCallRenderer.ts   # Tool call UI rendering and status updates
    ├── ThinkingBlockRenderer.ts # Extended thinking block UI with timer
    ├── TodoListRenderer.ts   # Todo list UI for TodoWrite tool
    ├── SubagentRenderer.ts   # Subagent (Task tool) collapsible UI with nested tools
    ├── EnvSnippetManager.ts  # Environment variable snippet management
    ├── InlineEditModal.ts    # Inline edit modal with diff preview
    └── inlineEditUtils.ts    # Pure utility functions (normalizeInsertionText, escapeHtml)
```

### UI Component Responsibilities

| Component | Responsibility |
|-----------|----------------|
| `ClaudianView` | Core chat view, message streaming, conversation management |
| `ApprovalModal` | Permission dialogs for Safe mode tool approval |
| `InputToolbar` | Model/thinking/permission selectors below textarea |
| `FileContext` | File attachment state, @mention dropdown, edited files indicator with hash-based revert/delete detection |
| `ImageContext` | Image drag/drop, paste, path detection, preview display |
| `SlashCommandManager` | Slash command detection, frontmatter parsing, and prompt expansion |
| `SlashCommandDropdown` | `/` dropdown UI with keyboard navigation (chat + inline edit) |
| `SlashCommandSettings` | Settings UI for creating/editing/importing/exporting slash commands |
| `ToolCallRenderer` | Tool call display with expand/collapse and status |
| `ThinkingBlockRenderer` | Extended thinking blocks with live timer |
| `TodoListRenderer` | Todo list display for TodoWrite tool calls |
| `SubagentRenderer` | Subagent (Task tool) UI for sync + async (nested tools vs. background polling, label shown on completion) |
| `WriteEditRenderer` | Collapsible Write/Edit blocks with inline diff |
| `DiffRenderer` | Line diff computation and rendering helpers |
| `EnvSnippetManager` | Environment variable snippet save/restore |
| `InlineEditModal` | Inline text editing with instruction input, @mentions, and inline diff preview |

## Key Technologies

- **Claude Agent SDK**: `@anthropic-ai/claude-agent-sdk` for Claude integration
- **Obsidian API**: Plugin framework, ItemView for sidebar, MarkdownRenderer
- **Build**: esbuild with TypeScript
- **Target**: Desktop only (macOS, Linux, Windows via WSL)

## Commands

```bash
# Development (watch mode)
npm run dev

# Production build
npm run build

# Install dependencies
npm install
```

## Key Implementation Patterns

### Claude Agent SDK Usage
```typescript
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';

const options: Options = {
  cwd: vaultPath,
  permissionMode: 'bypassPermissions',
  allowDangerouslySkipPermissions: true,
  model: settings.model,  // 'claude-haiku-4-5' | 'claude-sonnet-4-5' | 'claude-opus-4-5'
  // By default all SDK tools are available; optionally set `allowedTools` to restrict.
  // allowedTools: ['Read', 'Write'],
  abortController: this.abortController,
  pathToClaudeCodeExecutable: '/path/to/claude',
  resume: sessionId, // Optional: resume previous session
};

// Enable extended thinking based on thinking budget setting
const budgetConfig = THINKING_BUDGETS.find(b => b.value === settings.thinkingBudget);
if (budgetConfig && budgetConfig.tokens > 0) {
  options.maxThinkingTokens = budgetConfig.tokens;
}

const response = query({ prompt, options });
for await (const message of response) {
  // Handle streaming messages
}
```

### Obsidian View Registration
```typescript
this.registerView(VIEW_TYPE_CLAUDIAN, (leaf) => new ClaudianView(leaf, this));
```

### Vault Path Access
```typescript
const vaultPath = this.app.vault.adapter.basePath;
```

### Markdown Rendering
```typescript
await MarkdownRenderer.renderMarkdown(markdown, container, sourcePath, component);
```

### UI Component Usage
```typescript
// Import from barrel export
import {
  ApprovalModal,
  createInputToolbar,
  FileContextManager,
  renderToolCall,
  createThinkingBlock,
} from './ui';

// Create toolbar with callbacks
const toolbar = createInputToolbar(parentEl, {
  getSettings: () => plugin.settings,
  onModelChange: async (model) => { /* ... */ },
  onThinkingBudgetChange: async (budget) => { /* ... */ },
  onPermissionModeChange: async (mode) => { /* ... */ },
});

// Create file context manager
const fileContext = new FileContextManager(app, containerEl, inputEl, {
  getExcludedTags: () => settings.excludedTags,
  onFileOpen: async (path) => { /* ... */ },
});

// Render tool calls during streaming
renderToolCall(contentEl, toolCall, toolCallElements);

// Create thinking block with timer
const thinkingState = createThinkingBlock(contentEl, renderContentFn);
await appendThinkingContent(thinkingState, content, renderContentFn);
finalizeThinkingBlock(thinkingState);
```

### Slash Commands (Prompt Expansion)

- Slash commands are expanded by `SlashCommandManager` and integrated into both `ClaudianView` (chat) and `InlineEditModal` (inline edit).
- Expansion supports YAML frontmatter metadata, `$ARGUMENTS`/`$N` placeholders, `@file` references, and inline bash `` !`command` `` substitutions.
- Expansion order is placeholders → inline bash → file references, which prevents executing bash that appears inside referenced file content.
- Command-level overrides map to `QueryOptions` (`model`, `allowedTools`). If a command requests a different model than the active session model, the service drops `resume` and rebuilds the prompt from message history.
- User messages can preserve the original `/command ...` for display via `ChatMessage.displayContent`, while storing the expanded prompt in `ChatMessage.content`.

### Edited File Tracking (revert/delete aware)
- Pre-tool hook captures the original file hash before Write/Edit/NotebookEdit.
- Post-tool hook records post-edit hash and marks files as edited.
- Obsidian vault events (`delete`, `rename`, `modify`) remove or update indicators when files are deleted, renamed, or reverted to the original SHA-256 hash.
- Opening an edited file dismisses the indicator and clears hash state so the next edit re-baselines.

### Write/Edit Diff View (chat panel)
- Pre/Post ToolUse hooks capture original/new content keyed by `tool_use_id` (100KB cap both directions; larger or unreadable files recorded with `skippedReason`).
- Diff data is consumed once by `ClaudianView` using the matching tool id; subagent tool diffs are dropped from the main panel.
- Rendering uses `WriteEditRenderer` + `DiffRenderer` to show hunked inline diffs, with fallbacks for binary/too large/unavailable content and error states.

## SDK Message Types

| Type | Description |
|------|-------------|
| `system` | Session initialization (subtype: 'init' includes session_id), status updates |
| `assistant` | Claude's response containing content blocks (thinking, text, and/or tool_use) |
| `user` | User messages, also contains tool results via `tool_use_result` field |
| `stream_event` | Streaming deltas (content_block_start, content_block_delta) |
| `result` | Terminal message indicating completion |
| `error` | Error messages |

### Content Block Types (inside assistant.message.content)
- `thinking` - Extended thinking content with `thinking` field (when `maxThinkingTokens` is set)
- `text` - Text content with `text` field
- `tool_use` - Tool invocation with `id`, `name`, and `input` fields

### Tool Result Location (inside user messages)
- `user.tool_use_result` - The result of tool execution
- `user.parent_tool_use_id` - Links result to the original tool_use

## Available Tools

By default, all Claude Agent SDK tools are available. Some flows restrict tools via an `allowedTools` whitelist (e.g., Inline Edit and slash commands).

| Category | Tool | Description |
|----------|------|-------------|
| **File Operations** | `Read` | Read file contents |
| | `Write` | Create or overwrite files |
| | `Edit` | Make surgical edits (find/replace) |
| | `Glob` | Find files by pattern |
| | `Grep` | Search file contents with regex |
| | `LS` | List directory contents |
| | `NotebookEdit` | Edit Jupyter notebook cells |
| **Shell** | `Bash` | Execute shell commands |
| | `BashOutput` | Get output from background shells |
| | `KillShell` | Terminate background shells |
| **Web** | `WebSearch` | Search the web |
| | `WebFetch` | Fetch and process web content |
| **Task Management** | `Task` | Spawn subagents for complex tasks |
| | `TodoWrite` | Track task progress |

## Settings Structure

```typescript
interface ClaudianSettings {
  enableBlocklist: boolean;          // Block dangerous commands
  blockedCommands: string[];         // Regex patterns to block
  showToolUse: boolean;              // Show file operations in chat
  toolCallExpandedByDefault: boolean; // Expand tool calls by default
  model: ClaudeModel;                // Selected model (or custom model string)
  lastClaudeModel?: ClaudeModel;     // Last selected default model
  lastCustomModel?: ClaudeModel;     // Last selected custom model
  lastEnvHash?: string;              // Hash of active env vars (for model list reconciliation)
  thinkingBudget: ThinkingBudget;    // Extended thinking token budget
  permissionMode: PermissionMode;    // YOLO or Safe mode
  approvedActions: ApprovedAction[]; // Permanently approved actions
  excludedTags: string[];            // Tags that exclude files from auto-loading context
  mediaFolder: string;               // Attachment folder for embedded image references
  environmentVariables: string;      // Custom env vars in KEY=VALUE format
  envSnippets: EnvSnippet[];         // Saved environment variable configurations
  systemPrompt: string;              // Custom system prompt appended to default
  allowedExportPaths: string[];      // Paths outside vault where files can be exported
  slashCommands: SlashCommand[];     // Custom /commands
}

interface SlashCommand {
  id: string;
  name: string;
  description?: string;
  argumentHint?: string;
  allowedTools?: string[];
  model?: ClaudeModel;
  content: string;
}

interface ChatMessage {
  content: string;          // Stored/sent content (expanded prompt)
  displayContent?: string;  // UI-only content (e.g., "/review src/main.ts")
}

type ClaudeModel = string;  // Default models or custom model strings
type ThinkingBudget = 'off' | 'low' | 'medium' | 'high';
type PermissionMode = 'yolo' | 'normal';

interface ApprovedAction {
  toolName: string;     // Tool name (Bash, Read, Write, etc.)
  pattern: string;      // Command or file path pattern
  approvedAt: number;   // Timestamp
  scope: 'session' | 'always'; // Session-only or permanent
}

interface EnvSnippet {
  id: string;           // Unique identifier
  name: string;         // Display name
  description: string;  // Optional description
  envVars: string;      // Environment variables content
}
```

## Model Selection

### Default Claude Models

| Model | Description | Default Thinking Budget |
|-------|-------------|-------------------------|
| `claude-haiku-4-5` | Fast and efficient (default) | Off |
| `claude-sonnet-4-5` | Balanced performance | Low (4k tokens) |
| `claude-opus-4-5` | Most capable | Medium (8k tokens) |

### Custom Models via Environment Variables

When custom models are configured via environment variables, the model selector shows **only custom models** (no default Claude models). This provides a clean separation between using Anthropic's API directly and using alternative providers.

Custom models are detected from these environment variables (in priority order):
1. `ANTHROPIC_MODEL` - Generic model setting (highest priority)
2. `ANTHROPIC_DEFAULT_OPUS_MODEL` - Custom opus-tier model
3. `ANTHROPIC_DEFAULT_SONNET_MODEL` - Custom sonnet-tier model
4. `ANTHROPIC_DEFAULT_HAIKU_MODEL` - Custom haiku-tier model

The plugin remembers the last selected model within each category (default vs custom) for seamless switching between configurations.

## Thinking Budget

| Budget | Tokens | Description |
|--------|--------|-------------|
| Off | 0 | Thinking disabled |
| Low | 4,000 | Light reasoning |
| Medium | 8,000 | Moderate reasoning |
| High | 16,000 | Deep reasoning |

All models support extended thinking. When model is changed, thinking budget resets to model's default.

## Excluded Tags

Notes with specified tags will not auto-load as context when opened. This is useful for excluding system notes, templates, or private content from being automatically attached to conversations.

**Configuration**: Settings → Claudian → Excluded tags

Enter tags one per line (without the `#` prefix). Both frontmatter tags and inline tags are checked:

```yaml
# Frontmatter tags (both formats supported)
tags: [system, private]
tags: system

# Inline tags
#system #private
```

**Behavior**:
- Files with excluded tags won't auto-attach when opened (before session starts)
- Files with excluded tags won't auto-attach on new session creation
- Users can still manually attach excluded files via `@` mention

## Media Folder

Configure where Obsidian stores attachments/images so the agent can read embedded images from notes.

**Configuration**: Settings → Claudian → Media folder

When notes contain embedded images like `![[image.jpg]]` or `![[screenshot.png]]`, the agent needs to know where these files are stored to read them.

| Setting Value | Image Location | Example |
|---------------|----------------|---------|
| (empty) | Vault root | `./image.jpg` |
| `attachments` | `attachments/` folder | `./attachments/image.jpg` |
| `- attachments` | `- attachments/` folder | `./- attachments/image.jpg` |

**How it works**:
- The system prompt instructs the agent about the media folder location
- When the agent sees `![[image.jpg]]` in a note, it knows to read from the configured folder
- The agent uses the `Read` tool to view images (supports PNG, JPG, GIF, WebP)

**Example**: If your vault uses `- attachments` folder and a note contains:
```markdown
Here's a screenshot of the error:
![[error-screenshot.png]]
```

The agent will read `./- attachments/error-screenshot.png` to analyze the image.

### External Images

For standard markdown images with external URLs (`![alt text](url)`), WebFetch does **not** support images (only text and PDF). The agent must download the image first:

```markdown
Here's the architecture diagram:
![diagram](https://example.com/arch.png)
```

The agent will:
1. Download to cache: `curl -o .claudian-cache/temp/image.png "https://example.com/arch.png"`
2. Read the local file: `Read file_path=".claudian-cache/temp/image.png"`
3. **Always delete** after analysis: `rm .claudian-cache/temp/image.png`

## Environment Variables

Custom environment variables can be configured to use alternative API providers or customize Claude SDK behavior.

**Configuration**: Settings → Claudian → Environment variables

Enter variables in `KEY=VALUE` format (one per line). Supports comments (lines starting with `#`):

```
# Custom API provider
ANTHROPIC_BASE_URL=https://api.moonshot.cn/anthrop
ANTHROPIC_AUTH_TOKEN=your-token-here

# Custom model
ANTHROPIC_MODEL=kimi-k2-turbo
```

### Supported Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_MODEL` | Default model to use (highest priority) |
| `ANTHROPIC_BASE_URL` | Custom API endpoint URL |
| `ANTHROPIC_AUTH_TOKEN` | Authentication token |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Custom opus-tier model |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Custom sonnet-tier model |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Custom haiku-tier model |

### Environment Snippets

Save and restore environment variable configurations as named snippets for quick switching between providers.

**Actions**:
- **Save Current**: Save current environment variables as a new snippet
- **Insert**: Replace environment variables with snippet content
- **Edit**: Modify snippet name/description
- **Delete**: Remove a saved snippet

### Important Notes

- **Plugin restart required**: After directly editing environment variables in settings, restart the plugin for changes to take effect
- **No mixing**: When custom models are detected, only custom models appear in the model selector
- **Snippets are instant**: Using "Insert" on a snippet applies immediately (no restart needed)

## Image Support

Send images to Claude for analysis, description, or any vision-related task.

### Adding Images

**Three ways to attach images:**

1. **Drag and Drop**: Drag an image file onto the input area
2. **Copy/Paste**: Paste an image from clipboard (Cmd/Ctrl+V)
3. **File Path**: Include an image path in your message (e.g., `describe this: ./screenshots/error.png`)

### Supported Formats

| Format | Extension |
|--------|-----------|
| JPEG | `.jpg`, `.jpeg` |
| PNG | `.png` |
| GIF | `.gif` |
| WebP | `.webp` |

### Constraints

- **Maximum file size**: 5MB per image
- **Multiple images**: Attach several images in one message
- Images are sent as base64-encoded content blocks

### Path Detection

The plugin automatically detects image paths in your message text:
- Quoted paths: `"path/to/image.jpg"` or `'path/to/image.png'`
- Relative paths: `./screenshots/image.png`, `../assets/photo.jpg`
- Vault-relative paths: `attachments/diagram.png`
- Absolute paths: `/Users/name/Pictures/image.jpg`

When a valid image path is detected, the image is loaded and attached to the message automatically.

### Usage Example

```
Describe what you see in this image: ./design-mockup.png
```

Or drag an image and type:
```
What's wrong with this error screenshot?
```

## Inline Edit

Interact with text directly in your notes - ask questions, request edits, or insert new content - without using the sidebar chat.

### Modes

| Mode | Trigger | Output Tag | Description |
|------|---------|------------|-------------|
| **Selection** | Select text + hotkey | `<replacement>` | Edit or ask about selected text |
| **Cursor** | Place cursor + hotkey | `<insertion>` | Insert content at cursor position |

### How to Use

1. **Select text** or **place cursor** in any note
2. **Press hotkey** (configurable via Settings → Hotkeys → "Claudian: Inline edit")
3. **Enter request** - question, edit instruction, or insert request
4. **View response** - questions get conversational answers, edits/insertions show inline diff
5. **Accept (Enter) or Reject (Esc)** the changes

### Features

| Feature | Description |
|---------|-------------|
| **Inline input** | Input appears directly in the document (above selection or at cursor) |
| **Selection & cursor modes** | Edit selected text or insert at cursor position |
| **Word-level diff** | Precise diff showing exactly what changed |
| **Multi-turn conversation** | Agent can ask clarifying questions |
| **Read-only tools** | Agent can read files for context but cannot modify them |

### Tool Access

The inline edit agent has access to **read-only tools only**:

| Tool | Purpose |
|------|---------|
| `Read` | Read the current note or related files for context |
| `Grep` | Search for patterns across files |
| `Glob` | Find files by name pattern |
| `LS` | List directory contents |
| `WebSearch` | Search the web for information |
| `WebFetch` | Fetch and process web content |

Write tools (`Write`, `Edit`, `Bash`, etc.) are blocked via `allowedTools` whitelist and a `PreToolUse` safety hook.

### Prompt Structure

**Selection mode** - text between delimiters:
```
File: {path/to/note.md}

---
{selected text}
---

Request: {your question or instruction}
```

**Cursor mode** - cursor position marked with `|`:

`#inline` - cursor within a line of text:
```
File: {path/to/note.md}

---
text before|text after #inline
---

Request: {your instruction}
```

`#inbetween` - cursor on empty line (shows surrounding paragraphs):
```
File: {path/to/note.md}

---
Previous paragraph content
| #inbetween
Next paragraph content
---

Request: {your instruction}
```

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Custom (configurable) | Open inline edit at selection or cursor |
| `Enter` | Submit request / Accept changes |
| `Escape` | Cancel / Reject changes |

### Configuring Hotkeys

1. Go to **Settings → Hotkeys**
2. Search for "Claudian: Inline edit"
3. Click the **+** button and press your desired key combination

### Notes

- Inline edits are **separate from the main chat** - they don't appear in conversation history
- Uses the same model and thinking budget configured in settings
- Selection mode: Agent uses `<replacement>` tags for edits
- Cursor mode: Agent uses `<insertion>` tags for insertions
- Questions (either mode) get conversational responses without tags

## Permission Modes

| Mode | Description |
|------|-------------|
| YOLO | Bypass permission prompts (default). Claude executes tools without approval. |
| Safe | Require approval for tool usage. Shows approval dialog for each action. |

### Security Restrictions (Both Modes)

**Vault Restriction**: Agent can ONLY access files within the vault directory. Paths are normalized via `realpath` (symlink-safe) and Bash commands are scanned for path-like tokens; attempts to touch files outside the vault are blocked automatically. Exception: Export write operations to configured allowed export paths are permitted (write-only).

**Command Blocklist**: Dangerous bash commands are blocked even in YOLO mode.

### Allowed Export Paths

By default, the agent is restricted to the vault directory. You can configure a small set of external paths where files may be exported (written).

**Configuration**: Settings → Claudian → Safety → Allowed export paths

Enter one path per line. Supports `~` for the home directory:

```
~/Desktop
~/Downloads
/tmp
```

**Default**: `~/Desktop` and `~/Downloads`

**Behavior**:
- **Write/Edit/NotebookEdit** writes to these paths are allowed
- **Read/Glob/Grep/LS** remain vault-only
- **Bash** only allows these paths as write targets (e.g., `-o/--output`, `>` redirects, destination args for `cp/mv/rsync`); reads/listing in these paths are blocked

**Use Case**: Export notes to Desktop as `.docx`, `.pdf`, or other formats via shell commands:

```bash
pandoc ./note.md -o ~/Desktop/note.docx
```

### Approval Memory

When in Safe mode, actions can be approved with different scopes:
- **Allow Once** - Approve for this execution only
- **Always Allow** - Permanently approve (saved to settings)

Matching rules:
- Bash approvals require an exact command match.
- File tools allow exact or prefix path matches.

Permanently approved actions are stored and can be managed in Settings → Approved Actions.

## Default Blocked Commands

- `rm -rf` - Recursive force delete (could wipe vault)
- `chmod 777` - Unsafe file permissions
- `chmod -R 777` - Recursive unsafe permissions

## File Outputs

- `main.js` - Bundled plugin code
- `styles.css` - Plugin styles
- `manifest.json` - Obsidian plugin manifest

## External Dependencies

- User must have Claude Code CLI installed (SDK uses it internally via `pathToClaudeCodeExecutable`)
- Obsidian v1.0.0+

## CSS Class Conventions

### Layout
- `.claudian-container` - Main container
- `.claudian-header` - Header with title and action buttons
- `.claudian-title` - Logo and title container
- `.claudian-header-actions` - Right side action buttons container
- `.claudian-header-btn` - Icon buttons in header (history, new)
- `.claudian-messages` - Messages scroll area
- `.claudian-input-container` - Input area wrapper
- `.claudian-input-wrapper` - Border container for textarea + toolbar
- `.claudian-input` - Textarea input

### Chat History
- `.claudian-history-container` - Dropdown container (positioned relative)
- `.claudian-history-menu` - Dropdown menu (anchored to right)
- `.claudian-history-header` - "Conversations" header in dropdown
- `.claudian-history-list` - Scrollable conversation list
- `.claudian-history-item` - Individual conversation entry
- `.claudian-history-item-icon` - Chat icon for each entry
- `.claudian-history-item-content` - Title and date container
- `.claudian-history-item-title` - Conversation title (first 50 chars)
- `.claudian-history-item-date` - Timestamp metadata
- `.claudian-history-item-actions` - Rename/delete buttons

### Messages
- `.claudian-message` - Individual message
- `.claudian-message-user` - User message styling
- `.claudian-message-assistant` - Assistant message styling
- `.claudian-message-content` - Message content wrapper
- `.claudian-text-block` - Text block within message (maintains stream order)

### Tool Calls
- `.claudian-tool-call` - Tool call container (collapsible)
- `.claudian-tool-header` - Clickable header with tool info
- `.claudian-tool-icon` - Tool type icon
- `.claudian-tool-label` - Tool name and summary
- `.claudian-tool-status` - Status indicator (running/completed/error)
- `.claudian-spinner` - Loading spinner animation
- `.claudian-tool-content` - Collapsible content area
- `.claudian-tool-result-row` - Tree-branch result row container
- `.claudian-tool-branch` - Tree branch indicator (└─)
- `.claudian-tool-result-text` - Result text container
- `.claudian-tool-result-item` - Individual result line
- `.claudian-tool-result-bullet` - Bulleted result item (WebSearch)

### Extended Thinking
- `.claudian-thinking-block` - Thinking block container (expanded while streaming, collapsed when done)
- `.claudian-thinking-header` - Clickable header
- `.claudian-thinking-label` - Timer label ("Thinking Xs..." → "Thought for Xs", Claude orange)
- `.claudian-thinking-content` - Tree-branch style content (border-left indicator)

### Todo List (TodoWrite)
- `.claudian-todo-list` - Todo list container (expanded by default, click to collapse)
- `.claudian-todo-header` - Clickable header with task count
- `.claudian-todo-icon` - List-checks icon
- `.claudian-todo-label` - Label showing "Tasks (completed/total)"
- `.claudian-todo-content` - Collapsible todo items container
- `.claudian-todo-item` - Individual todo item row
- `.claudian-todo-pending` - Pending task styling (muted, circle icon)
- `.claudian-todo-in_progress` - In-progress task styling (accent color, spinning loader)
- `.claudian-todo-completed` - Completed task styling (green checkmark, strikethrough)
- `.claudian-todo-status-icon` - Status indicator icon (circle/loader/check)
- `.claudian-todo-text` - Task description text

### Subagent (Task Tool)
- `.claudian-subagent-list` - Subagent container (expanded by default during streaming)
- `.claudian-subagent-list.expanded` - Expanded state
- `.claudian-subagent-list.done` - Completed state
- `.claudian-subagent-list.error` - Error state
- `.claudian-subagent-header` - Clickable header with subagent info
- `.claudian-subagent-icon` - Bot icon
- `.claudian-subagent-label` - Task description text
- `.claudian-subagent-count` - Tool count badge ("N tool uses")
- `.claudian-subagent-status` - Status indicator (spinner/check/x)
- `.claudian-subagent-content` - Collapsible content area
- `.claudian-subagent-branch` - Tree branch indicator (└─)
- `.claudian-subagent-tool-item` - Current tool display container
- `.claudian-subagent-tool-row` - Tool row (branch + label)
- `.claudian-subagent-tool-text` - Tool name/label text
- `.claudian-subagent-tool-result` - Nested result area
- `.claudian-subagent-result-text` - Result text (max 2 lines)
- `.claudian-subagent-done` - DONE/ERROR indicator row
- `.claudian-subagent-done-text` - DONE/ERROR text

### Model Selector
- `.claudian-input-toolbar` - Toolbar below input textarea
- `.claudian-model-selector` - Model selector container
- `.claudian-model-btn` - Current model button (clickable)
- `.claudian-model-label` - Model name label
- `.claudian-model-chevron` - Dropdown chevron icon
- `.claudian-model-dropdown` - Dropdown menu
- `.claudian-model-option` - Individual model option

### File Context
- `.claudian-file-indicator` - Container for attached file chips
- `.claudian-file-chip` - Individual file tag (pill style)
- `.claudian-file-chip-icon` - File icon in chip
- `.claudian-file-chip-name` - Filename text
- `.claudian-file-chip-remove` - Remove button (×)
- `.claudian-mention-dropdown` - @ mention file picker dropdown
- `.claudian-mention-item` - Individual file option in dropdown
- `.claudian-mention-icon` - File icon in dropdown
- `.claudian-mention-path` - File path text in dropdown
- `.claudian-mention-empty` - "No matching files" message

### Permission Mode Toggle
- `.claudian-permission-toggle` - Container for toggle switch
- `.claudian-permission-label` - Label showing "YOLO" or "Safe"
- `.claudian-toggle-switch` - Toggle switch element
- `.claudian-toggle-switch.active` - Active state (YOLO mode)

### Approval Modal
- `.claudian-approval-modal` - Modal container
- `.claudian-approval-title` - Modal title
- `.claudian-approval-info` - Tool info section
- `.claudian-approval-tool` - Tool name with icon
- `.claudian-approval-desc` - Action description
- `.claudian-approval-buttons` - Button container
- `.claudian-approval-btn` - Base button class
- `.claudian-deny-btn` - Deny button
- `.claudian-allow-btn` - Allow Once button
- `.claudian-always-btn` - Always Allow button

### Approved Actions (Settings)
- `.claudian-approved-list` - List container
- `.claudian-approved-item` - Individual action item
- `.claudian-approved-item-tool` - Tool name badge
- `.claudian-approved-item-pattern` - Pattern text
- `.claudian-approved-item-date` - Approval date
- `.claudian-approved-remove-btn` - Remove button

### Environment Snippets (Settings)
- `.claudian-env-snippets-container` - Main snippets container
- `.claudian-snippet-header` - Header with title and save button
- `.claudian-save-env-btn` - "Save Current" button
- `.claudian-snippet-empty` - Empty state message
- `.claudian-snippet-list` - List of saved snippets
- `.claudian-snippet-item` - Individual snippet item
- `.claudian-snippet-info` - Snippet name and description container
- `.claudian-snippet-name` - Snippet name
- `.claudian-snippet-description` - Snippet description
- `.claudian-snippet-actions` - Action buttons container
- `.claudian-restore-snippet-btn` - "Insert" button
- `.claudian-edit-snippet-btn` - "Edit" button
- `.claudian-delete-snippet-btn` - "Delete" button
- `.claudian-env-snippet-modal` - Snippet create/edit modal
- `.claudian-snippet-preview` - Environment preview in modal
- `.claudian-env-preview` - Preformatted env vars display
- `.claudian-snippet-buttons` - Modal button container
- `.claudian-settings-env-textarea` - Environment variables textarea in settings

### Image Attachments
- `.claudian-image-preview` - Container for image previews in input area
- `.claudian-image-chip` - Individual image preview chip
- `.claudian-image-thumb` - Thumbnail container
- `.claudian-image-info` - Image name and size container
- `.claudian-image-name` - Image filename
- `.claudian-image-size` - File size display
- `.claudian-image-remove` - Remove button (×)
- `.claudian-drop-overlay` - Drag-and-drop overlay
- `.claudian-drop-content` - Drop overlay content (icon + text)
- `.claudian-message-images` - Container for images in messages
- `.claudian-message-image` - Individual image in message
- `.claudian-image-modal-overlay` - Full-size image modal backdrop
- `.claudian-image-modal` - Full-size image modal container
- `.claudian-image-modal-close` - Modal close button

### Inline Edit (CM6 Widget)
- `.claudian-inline-selection` - Selection highlight (uses `--text-selection`)
- `.claudian-inline-input-container` - Main container (transparent bg)
- `.claudian-inline-agent-reply` - Agent clarification message box (shown during conversation)
- `.claudian-inline-input-wrap` - Input wrapper (relative positioned)
- `.claudian-inline-input` - Text input (transparent, no focus highlight)
- `.claudian-inline-spinner` - Loading spinner (Claude orange)
- `.claudian-inline-diff-replace` - Diff container replacing selection
- `.claudian-diff-del` - Deleted text styling (red strikethrough)
- `.claudian-diff-ins` - Inserted text styling (green highlight)
- `.claudian-inline-diff-buttons` - Accept/reject button container
- `.claudian-inline-diff-btn` - Base button class
- `.claudian-inline-diff-btn.reject` - Reject button
- `.claudian-inline-diff-btn.accept` - Accept button

## Notes
- Test Driven Development
- when ask to generate a md file about the finding, implementation of your work, put the file in dev/
- when ask to update docs, update development note in dev/ , CLAUDE.md and README.md
