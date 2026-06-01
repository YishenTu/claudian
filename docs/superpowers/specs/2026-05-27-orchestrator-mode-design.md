# Orchestrator Mode Design

**Date:** 2026-05-27
**Status:** Approved for implementation

## Overview

Orchestrator Mode is a new conversation mode for Claudian that lets a single "orchestrator" agent decompose a high-level goal into parallel tasks, spawn independent worker agents (each in its own tab), collect their results, and synthesize a final answer — all within the existing multi-tab model.

The user interacts only with the orchestrator tab. Workers run autonomously in background tabs and can pause to ask questions when stuck. When all workers finish, the orchestrator synthesizes the results.

---

## Architecture

Four new components slot into the existing tab and conversation model without modifying `StreamController`, `SubagentManager`, `ConversationController`, or `TabManager`.

### New: `OrchestratorService`

**Location:** `src/features/chat/services/OrchestratorService.ts`

Owns the fleet. Maintains:
- `Map<orchestratorTabId, WorkerTabId[]>` — tracks spawned workers per orchestrator
- `Map<workerTabId, WorkerResult>` — buffers results as workers finish

**Public API:**
- `spawnWorkerTabs(orchestratorTabId, tasks[])` — calls `TabManager.addTab()` with `isWorker: true` for each task, sets `tab.orchestratorTabId`, sends the task prompt as the first message via `InputController.sendMessage()`, then returns focus to the orchestrator tab
- `reportResult(workerTabId, result, isError?)` — buffers the result, injects a synthetic user message into the orchestrator conversation, and when all workers have reported fires the synthesis trigger
- `handleWorkerClosed(workerTabId)` — marks the worker as abandoned and counts it as done for the all-finished check
- `handleOrchestratorClosed(orchestratorTabId)` — clears the fleet entry; subsequent `reportResult` calls for orphaned workers become no-ops

Hooks into existing `TabManager` callbacks (`onTabAttentionChanged`, `onTabClosed`) rather than modifying them.

### New: `InlineOrchestratorPlan` renderer

**Location:** `src/features/chat/rendering/InlineOrchestratorPlan.ts`

Rendered when `StreamController` detects an `orchestrator_plan` block in the text stream (same detection pattern as `InlineAskUserQuestion`). Displays the task list with descriptions and an Approve / Cancel button pair.

- **Approve** → calls `OrchestratorService.spawnWorkerTabs()`
- **Cancel** → no-op; leaves the conversation in place without spawning anything
- **Empty task list** → renders an inline error state instead of the Approve button

### Modified: `TabData` (`src/features/chat/tabs/types.ts`)

Two optional fields added:

```typescript
orchestratorTabId?: TabId | null;  // set on worker tabs
workerTabIds?: TabId[];            // set on orchestrator tabs
```

No existing fields are changed.

### Modified: `Conversation` (`src/core/types/chat.ts`)

One optional field added:

```typescript
orchestratorMode?: boolean;
```

Persists the mode flag across sessions.

---

## Plan Format

The orchestrator emits a fenced JSON block that all providers can produce without tool definitions:

````
```json
{
  "type": "orchestrator_plan",
  "tasks": [
    { "id": "1", "description": "Research vault for X", "prompt": "Search the vault for notes about X and summarize the key points." },
    { "id": "2", "description": "Draft blog post", "prompt": "Write a blog post about X. Be thorough and well-structured." }
  ]
}
```
````

`StreamController` detects this block by the `"type":"orchestrator_plan"` marker, suppresses it from plain-text rendering, and hands it to `InlineOrchestratorPlan`. If the block is malformed, `StreamController` falls back to rendering it as a plain fenced code block with no side effects.

---

## System Prompt

When `orchestratorMode` is true, `prepareTurn()` appends a short suffix to the system prompt explaining the plan format and when to use it. The suffix is provider-neutral plain text — no tool definitions required. It instructs the orchestrator to:

1. Decompose the user's goal into 2–5 independent tasks
2. Emit a single `orchestrator_plan` block (not prose)
3. Wait for the user to approve before any work begins
4. Synthesize all worker results when prompted

---

## Orchestrator Mode Activation

A new toggle in the tab input toolbar (adjacent to Plan Mode). Toggling it sets `conversation.orchestratorMode = true` and persists the change. When active, a small `⚡` prefix appears in the tab's `TabBarItem` title.

---

## Worker Tab Lifecycle

### Spawning

On Approve, `OrchestratorService.spawnWorkerTabs()`:
1. Calls `TabManager.addTab({ isWorker: true })` — worker tabs bypass the user-configured tab limit
2. Sets `tab.orchestratorTabId = orchestratorTabId`
3. Appends `tab.id` to the orchestrator's `workerTabIds`
4. Immediately sends the task prompt as the first user message
5. Returns focus to the orchestrator tab

### Tab bar identity

- **Orchestrator tab:** `⚡` prefix in the tab bar title
- **Worker tabs:** task description truncated to ~20 chars + `◌` spinner; transitions to `✓` on completion or `✗` on error

### Running

Worker tabs behave like normal tabs. `InlineAskUserQuestion` handles any questions the worker asks the user. The `onTabAttentionChanged` callback fires when a worker needs the user, making the tab badge the discovery mechanism.

### Reporting back

When `StreamController` processes a `done` chunk and `tab.orchestratorTabId !== null`, it calls `OrchestratorService.reportResult(workerTabId, finalAssistantMessage)`.

`OrchestratorService`:
- Buffers the result
- Immediately calls `InputController.sendMessage()` on the orchestrator tab with: `"Worker '[description]' finished: [result]"` — this appears in conversation history and triggers a new stream turn
- When all workers have reported (or closed/errored), sends one final message: `"All workers have reported. Please synthesize."` the same way

### Worker closed early

`OrchestratorService.handleWorkerClosed()` injects `"Worker '[description]' was closed before completing."` and counts the worker as done for the all-finished check.

### Orchestrator closed

Worker tabs continue running. Their `orchestratorTabId` remains set but `reportResult()` checks for a live orchestrator tab and becomes a no-op if it is gone.

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Worker emits `error` chunk | `reportResult(tabId, message, isError: true)` → `"Worker '[description]' failed: [message]"` injected into orchestrator; counted as done |
| Malformed plan block | Falls back to plain fenced code rendering; no workers spawned |
| Empty task list in plan | `InlineOrchestratorPlan` shows inline error; no Approve button |
| `TabManager.addTab()` fails | `"Failed to spawn worker for '[description]'"` injected immediately; counted as done |

---

## Testing

### Unit — `OrchestratorService`

- `spawnWorkerTabs` registers workers and sets `orchestratorTabId` on each
- `reportResult` buffers correctly and does not fire synthesis trigger until all workers done
- Synthesis trigger fires exactly once when all workers have reported
- Worker closed early counts as done for the all-finished check
- `reportResult` after orchestrator closed is a no-op

### Unit — plan detection in `StreamController`

- Valid `orchestrator_plan` block suppresses plain-text rendering and triggers `InlineOrchestratorPlan`
- Malformed block falls back to plain fenced code
- Block split across multiple stream chunks is assembled correctly before detection

### Unit — `InlineOrchestratorPlan`

- Renders correct number of task rows
- Approve calls `OrchestratorService.spawnWorkerTabs` with the parsed tasks
- Cancel leaves the conversation unchanged
- Empty task list renders error state, not Approve button

### Integration — full flow

Full orchestrator → plan approval → N worker tabs created → results injected in arrival order → synthesis trigger sent once all done. Uses mocked `TabManager` and `InputController`.
