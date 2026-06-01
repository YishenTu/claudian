# Orchestrator Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Orchestrator conversation mode where one agent decomposes a goal into parallel worker tabs, collects their results, and synthesizes a final answer.

**Architecture:** A new `OrchestratorService` owns the fleet (orchestrator → worker mappings) and result-injection callbacks. `StreamController` detects a `orchestrator_plan` JSON block in the assistant's `done` event, renders an `InlineOrchestratorPlan` approval widget, and reports worker completion back to the service. Workers run as normal tabs; no changes to `SubagentManager`, `ConversationController`, or the core runtime.

**Tech Stack:** TypeScript, Obsidian plugin API, Jest + jsdom (unit tests). Path aliases: `@/` → `src/`, `@test/` → `tests/`.

---

### Task 1: Type additions

**Files:**
- Modify: `src/core/types/chat.ts`
- Modify: `src/features/chat/tabs/types.ts`

- [ ] **Step 1: Add `orchestratorMode` to `Conversation`**

In `src/core/types/chat.ts`, find the `Conversation` interface and add one optional field immediately after `enabledMcpServers`:

```typescript
  /** When true, this conversation is an orchestrator that can spawn worker tabs. */
  orchestratorMode?: boolean;
```

- [ ] **Step 2: Add worker/orchestrator fields to `TabData`**

In `src/features/chat/tabs/types.ts`, find the `TabData` interface and add two optional fields after `renderer`:

```typescript
  /** Set on worker tabs: the tab ID of the orchestrator that spawned this tab. */
  orchestratorTabId?: TabId | null;

  /** Set on orchestrator tabs: IDs of all worker tabs spawned by this orchestrator. */
  workerTabIds?: TabId[];
```

- [ ] **Step 3: Run the type checker to verify no breakage**

```
npm run typecheck
```

Expected: No new errors.

- [ ] **Step 4: Commit**

```bash
git add src/core/types/chat.ts src/features/chat/tabs/types.ts
git commit -m "feat: add orchestratorMode and worker tab fields to core types"
```

---

### Task 2: Plan block parser

**Files:**
- Create: `src/features/chat/rendering/orchestratorPlanParser.ts`
- Create: `tests/unit/features/chat/rendering/orchestratorPlanParser.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/features/chat/rendering/orchestratorPlanParser.test.ts`:

```typescript
import {
  extractOrchestratorPlan,
  type OrchestratorPlan,
  type OrchestratorTask,
} from '@/features/chat/rendering/orchestratorPlanParser';

const VALID_PLAN: OrchestratorPlan = {
  type: 'orchestrator_plan',
  tasks: [
    { id: '1', description: 'Research vault', prompt: 'Search the vault for notes about X.' },
    { id: '2', description: 'Draft post', prompt: 'Write a blog post about X.' },
  ],
};

const VALID_TEXT = `Here is my plan:\n\`\`\`json\n${JSON.stringify(VALID_PLAN, null, 2)}\n\`\`\`\nPlease approve.`;

describe('extractOrchestratorPlan', () => {
  it('extracts a valid orchestrator_plan block', () => {
    expect(extractOrchestratorPlan(VALID_TEXT)).toEqual(VALID_PLAN);
  });

  it('returns null when no code block is present', () => {
    expect(extractOrchestratorPlan('No plan here.')).toBeNull();
  });

  it('returns null for a code block without type orchestrator_plan', () => {
    const text = '```json\n{"type":"other","tasks":[]}\n```';
    expect(extractOrchestratorPlan(text)).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    const text = '```json\n{"type":"orchestrator_plan","tasks":[{broken}\n```';
    expect(extractOrchestratorPlan(text)).toBeNull();
  });

  it('returns null for empty task list', () => {
    const text = '```json\n{"type":"orchestrator_plan","tasks":[]}\n```';
    expect(extractOrchestratorPlan(text)).toBeNull();
  });

  it('returns null when a task is missing required fields', () => {
    const text = '```json\n{"type":"orchestrator_plan","tasks":[{"id":"1"}]}\n```';
    expect(extractOrchestratorPlan(text)).toBeNull();
  });

  it('works when the block uses a plain ``` fence (no language tag)', () => {
    const text = `\`\`\`\n${JSON.stringify(VALID_PLAN)}\n\`\`\``;
    expect(extractOrchestratorPlan(text)).toEqual(VALID_PLAN);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```
npm run test -- --selectProjects unit --testPathPattern orchestratorPlanParser
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the parser**

Create `src/features/chat/rendering/orchestratorPlanParser.ts`:

```typescript
export interface OrchestratorTask {
  id: string;
  description: string;
  prompt: string;
}

export interface OrchestratorPlan {
  type: 'orchestrator_plan';
  tasks: OrchestratorTask[];
}

const PLAN_BLOCK_RE = /```(?:json)?\s*\n([\s\S]*?)\n```/g;

export function extractOrchestratorPlan(text: string): OrchestratorPlan | null {
  PLAN_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLAN_BLOCK_RE.exec(text)) !== null) {
    const plan = tryParsePlan(match[1]);
    if (plan) return plan;
  }
  return null;
}

function tryParsePlan(json: string): OrchestratorPlan | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return isValidPlan(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isValidPlan(value: unknown): value is OrchestratorPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (obj['type'] !== 'orchestrator_plan') return false;
  if (!Array.isArray(obj['tasks']) || obj['tasks'].length === 0) return false;
  return (obj['tasks'] as unknown[]).every(isValidTask);
}

function isValidTask(value: unknown): value is OrchestratorTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj['id'] === 'string' &&
    typeof obj['description'] === 'string' &&
    typeof obj['prompt'] === 'string'
  );
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```
npm run test -- --selectProjects unit --testPathPattern orchestratorPlanParser
```

Expected: 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/chat/rendering/orchestratorPlanParser.ts \
        tests/unit/features/chat/rendering/orchestratorPlanParser.test.ts
git commit -m "feat: add orchestrator plan block parser"
```

---

### Task 3: OrchestratorService

**Files:**
- Create: `src/features/chat/services/OrchestratorService.ts`
- Create: `tests/unit/features/chat/services/OrchestratorService.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/features/chat/services/OrchestratorService.test.ts`:

```typescript
import { OrchestratorService } from '@/features/chat/services/OrchestratorService';

function makeService() {
  const sent: Array<{ tabId: string; message: string }> = [];
  const service = new OrchestratorService({
    sendToTab: (tabId, message) => sent.push({ tabId, message }),
  });
  return { service, sent };
}

describe('OrchestratorService', () => {
  describe('registerWorker / getOrchestratorTabId', () => {
    it('returns null for unknown tab', () => {
      const { service } = makeService();
      expect(service.getOrchestratorTabId('unknown')).toBeNull();
    });

    it('returns orchestrator tab id after registration', () => {
      const { service } = makeService();
      service.registerWorker('orch-1', 'worker-1', 'Research');
      expect(service.getOrchestratorTabId('worker-1')).toBe('orch-1');
    });
  });

  describe('reportResult', () => {
    it('sends result message to orchestrator', () => {
      const { service, sent } = makeService();
      service.registerWorker('orch-1', 'worker-1', 'Research');
      service.reportResult('worker-1', 'Found 3 notes.');
      expect(sent).toContainEqual({
        tabId: 'orch-1',
        message: "Worker 'Research' finished: Found 3 notes.",
      });
    });

    it('sends error message when isError is true', () => {
      const { service, sent } = makeService();
      service.registerWorker('orch-1', 'worker-1', 'Research');
      service.reportResult('worker-1', 'Something went wrong.', true);
      expect(sent[0].message).toBe("Worker 'Research' failed: Something went wrong.");
    });

    it('sends synthesis trigger when all workers done', () => {
      const { service, sent } = makeService();
      service.registerWorker('orch-1', 'worker-1', 'Research');
      service.registerWorker('orch-1', 'worker-2', 'Write');
      service.reportResult('worker-1', 'result-1');
      expect(sent).not.toContainEqual(expect.objectContaining({ message: 'All workers have reported. Please synthesize.' }));
      service.reportResult('worker-2', 'result-2');
      expect(sent).toContainEqual({
        tabId: 'orch-1',
        message: 'All workers have reported. Please synthesize.',
      });
    });

    it('is a no-op for unknown worker', () => {
      const { service, sent } = makeService();
      service.reportResult('ghost', 'result');
      expect(sent).toHaveLength(0);
    });

    it('is a no-op if called twice for the same worker', () => {
      const { service, sent } = makeService();
      service.registerWorker('orch-1', 'worker-1', 'Research');
      service.reportResult('worker-1', 'first');
      const countAfterFirst = sent.length;
      service.reportResult('worker-1', 'second');
      expect(sent).toHaveLength(countAfterFirst);
    });
  });

  describe('handleTabClosed', () => {
    it('counts closed worker as done and notifies orchestrator', () => {
      const { service, sent } = makeService();
      service.registerWorker('orch-1', 'worker-1', 'Research');
      service.handleTabClosed('worker-1');
      expect(sent[0].message).toContain("closed before completing");
    });

    it('fires synthesis trigger if closed worker was the last', () => {
      const { service, sent } = makeService();
      service.registerWorker('orch-1', 'worker-1', 'Research');
      service.handleTabClosed('worker-1');
      expect(sent).toContainEqual({
        tabId: 'orch-1',
        message: 'All workers have reported. Please synthesize.',
      });
    });

    it('is a no-op for orchestrator tab that is closed', () => {
      const { service, sent } = makeService();
      service.registerWorker('orch-1', 'worker-1', 'Research');
      service.handleTabClosed('orch-1');
      // Workers' subsequent reportResult should not crash and should be no-op
      service.reportResult('worker-1', 'late result');
      expect(sent).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```
npm run test -- --selectProjects unit --testPathPattern OrchestratorService
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement OrchestratorService**

Create `src/features/chat/services/OrchestratorService.ts`:

```typescript
import type { TabId } from '../tabs/types';

export interface OrchestratorServiceDeps {
  sendToTab: (tabId: TabId, message: string) => void;
}

interface WorkerMeta {
  orchestratorTabId: TabId;
  description: string;
  done: boolean;
}

export class OrchestratorService {
  private deps: OrchestratorServiceDeps;
  private workerSets = new Map<TabId, Set<TabId>>();
  private workerMeta = new Map<TabId, WorkerMeta>();

  constructor(deps: OrchestratorServiceDeps) {
    this.deps = deps;
  }

  registerWorker(orchestratorTabId: TabId, workerTabId: TabId, description: string): void {
    if (!this.workerSets.has(orchestratorTabId)) {
      this.workerSets.set(orchestratorTabId, new Set());
    }
    this.workerSets.get(orchestratorTabId)!.add(workerTabId);
    this.workerMeta.set(workerTabId, { orchestratorTabId, description, done: false });
  }

  reportResult(workerTabId: TabId, result: string, isError = false): void {
    const meta = this.workerMeta.get(workerTabId);
    if (!meta || meta.done) return;
    meta.done = true;

    // Orchestrator may have been closed; guard against sending to a dead tab.
    if (!this.workerSets.has(meta.orchestratorTabId)) return;

    const label = isError
      ? `Worker '${meta.description}' failed: ${result}`
      : `Worker '${meta.description}' finished: ${result}`;
    this.deps.sendToTab(meta.orchestratorTabId, label);
    this.checkAllDone(meta.orchestratorTabId);
  }

  handleTabClosed(tabId: TabId): void {
    const meta = this.workerMeta.get(tabId);
    if (meta && !meta.done) {
      meta.done = true;
      if (this.workerSets.has(meta.orchestratorTabId)) {
        this.deps.sendToTab(
          meta.orchestratorTabId,
          `Worker '${meta.description}' was closed before completing.`,
        );
        this.checkAllDone(meta.orchestratorTabId);
      }
    }
    // If this is an orchestrator tab, drop the fleet so future reportResult calls are no-ops.
    this.workerSets.delete(tabId);
  }

  getOrchestratorTabId(workerTabId: TabId): TabId | null {
    return this.workerMeta.get(workerTabId)?.orchestratorTabId ?? null;
  }

  private checkAllDone(orchestratorTabId: TabId): void {
    const workers = this.workerSets.get(orchestratorTabId);
    if (!workers) return;
    const allDone = [...workers].every((id) => this.workerMeta.get(id)?.done === true);
    if (allDone) {
      this.deps.sendToTab(orchestratorTabId, 'All workers have reported. Please synthesize.');
    }
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```
npm run test -- --selectProjects unit --testPathPattern OrchestratorService
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/chat/services/OrchestratorService.ts \
        tests/unit/features/chat/services/OrchestratorService.test.ts
git commit -m "feat: add OrchestratorService fleet manager"
```

---

### Task 4: InlineOrchestratorPlan renderer

**Files:**
- Create: `src/features/chat/rendering/InlineOrchestratorPlan.ts`
- Create: `tests/unit/features/chat/rendering/InlineOrchestratorPlan.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/features/chat/rendering/InlineOrchestratorPlan.test.ts`:

```typescript
/** @jest-environment jsdom */

import { createMockEl } from '@test/helpers/mockElement';

import { InlineOrchestratorPlan } from '@/features/chat/rendering/InlineOrchestratorPlan';
import type { OrchestratorPlan, OrchestratorTask } from '@/features/chat/rendering/orchestratorPlanParser';

const PLAN: OrchestratorPlan = {
  type: 'orchestrator_plan',
  tasks: [
    { id: '1', description: 'Research', prompt: 'Search for X.' },
    { id: '2', description: 'Write', prompt: 'Write about X.' },
  ],
};

describe('InlineOrchestratorPlan', () => {
  it('renders a task row for each task', () => {
    const container = createMockEl();
    new InlineOrchestratorPlan(container, PLAN, jest.fn(), jest.fn()).render();
    const items = container.querySelectorAll('.claudian-orchestrator-plan-task');
    expect(items).toHaveLength(2);
  });

  it('calls onApprove with the plan tasks when Spawn Workers is clicked', () => {
    const container = createMockEl();
    const onApprove = jest.fn();
    new InlineOrchestratorPlan(container, PLAN, onApprove, jest.fn()).render();
    const btn = container.querySelector('.claudian-orchestrator-plan-approve') as HTMLButtonElement;
    btn.click();
    expect(onApprove).toHaveBeenCalledWith(PLAN.tasks);
  });

  it('does not call onApprove when Cancel is clicked', () => {
    const container = createMockEl();
    const onApprove = jest.fn();
    const onCancel = jest.fn();
    new InlineOrchestratorPlan(container, PLAN, onApprove, onCancel).render();
    const btn = container.querySelector('.claudian-orchestrator-plan-cancel') as HTMLButtonElement;
    btn.click();
    expect(onApprove).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it('disables both buttons after Approve is clicked', () => {
    const container = createMockEl();
    new InlineOrchestratorPlan(container, PLAN, jest.fn(), jest.fn()).render();
    const approve = container.querySelector('.claudian-orchestrator-plan-approve') as HTMLButtonElement;
    const cancel = container.querySelector('.claudian-orchestrator-plan-cancel') as HTMLButtonElement;
    approve.click();
    expect(approve.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```
npm run test -- --selectProjects unit --testPathPattern InlineOrchestratorPlan
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement InlineOrchestratorPlan**

Create `src/features/chat/rendering/InlineOrchestratorPlan.ts`:

```typescript
import type { OrchestratorPlan, OrchestratorTask } from './orchestratorPlanParser';

export class InlineOrchestratorPlan {
  private containerEl: HTMLElement;
  private plan: OrchestratorPlan;
  private onApprove: (tasks: OrchestratorTask[]) => void;
  private onCancel: () => void;

  constructor(
    containerEl: HTMLElement,
    plan: OrchestratorPlan,
    onApprove: (tasks: OrchestratorTask[]) => void,
    onCancel: () => void,
  ) {
    this.containerEl = containerEl;
    this.plan = plan;
    this.onApprove = onApprove;
    this.onCancel = onCancel;
  }

  render(): void {
    const rootEl = this.containerEl.createDiv({ cls: 'claudian-orchestrator-plan' });

    const count = this.plan.tasks.length;
    rootEl
      .createDiv({ cls: 'claudian-orchestrator-plan-header' })
      .createEl('h4', { text: `Spawn ${count} worker${count !== 1 ? 's' : ''}?` });

    const listEl = rootEl.createEl('ul', { cls: 'claudian-orchestrator-plan-tasks' });
    for (const task of this.plan.tasks) {
      listEl.createEl('li', { cls: 'claudian-orchestrator-plan-task' })
            .createEl('strong', { text: task.description });
    }

    const actionsEl = rootEl.createDiv({ cls: 'claudian-orchestrator-plan-actions' });

    const approveBtn = actionsEl.createEl('button', {
      cls: 'claudian-orchestrator-plan-approve mod-cta',
      text: 'Spawn Workers',
    });
    const cancelBtn = actionsEl.createEl('button', {
      cls: 'claudian-orchestrator-plan-cancel',
      text: 'Cancel',
    });

    const disable = () => {
      approveBtn.disabled = true;
      cancelBtn.disabled = true;
    };

    approveBtn.addEventListener('click', () => {
      disable();
      this.onApprove(this.plan.tasks);
    });

    cancelBtn.addEventListener('click', () => {
      disable();
      this.onCancel();
    });
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```
npm run test -- --selectProjects unit --testPathPattern InlineOrchestratorPlan
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/chat/rendering/InlineOrchestratorPlan.ts \
        tests/unit/features/chat/rendering/InlineOrchestratorPlan.test.ts
git commit -m "feat: add InlineOrchestratorPlan approval renderer"
```

---

### Task 5: MessageRenderer accessor

**Files:**
- Modify: `src/features/chat/rendering/MessageRenderer.ts`

- [ ] **Step 1: Add `getMessageEl` to `MessageRenderer`**

In `src/features/chat/rendering/MessageRenderer.ts`, the class already has `private liveMessageEls = new Map<string, HTMLElement>()`. Add a public accessor after the existing methods:

```typescript
  /** Returns the DOM element for a rendered message, or null if not tracked. */
  getMessageEl(msgId: string): HTMLElement | null {
    return this.liveMessageEls.get(msgId) ?? null;
  }
```

- [ ] **Step 2: Run typecheck**

```
npm run typecheck
```

Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add src/features/chat/rendering/MessageRenderer.ts
git commit -m "feat: expose getMessageEl on MessageRenderer"
```

---

### Task 6: StreamController — plan detection and worker done-reporting

**Files:**
- Modify: `src/features/chat/controllers/StreamController.ts`
- Create: `tests/unit/features/chat/controllers/StreamController.orchestrator.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/features/chat/controllers/StreamController.orchestrator.test.ts`:

```typescript
import { extractOrchestratorPlan } from '@/features/chat/rendering/orchestratorPlanParser';

// Test the pure detection logic only — StreamController wiring is integration territory.
describe('orchestrator plan detection', () => {
  it('detects a plan block inside assistant message content', () => {
    const plan = {
      type: 'orchestrator_plan',
      tasks: [
        { id: '1', description: 'Research', prompt: 'Search the vault.' },
      ],
    };
    const content = `I will break this into tasks:\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``;
    const result = extractOrchestratorPlan(content);
    expect(result).not.toBeNull();
    expect(result!.tasks).toHaveLength(1);
  });

  it('returns null when the assistant message has no plan block', () => {
    expect(extractOrchestratorPlan('Just a regular response.')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to confirm they pass (these use the already-implemented parser)**

```
npm run test -- --selectProjects unit --testPathPattern StreamController.orchestrator
```

Expected: PASS — the parser already works.

- [ ] **Step 3: Add new deps to `StreamControllerDeps`**

In `src/features/chat/controllers/StreamController.ts`, find the `StreamControllerDeps` interface and add two optional fields:

```typescript
  /** Called when a complete assistant message contains an orchestrator plan block. */
  onOrchestratorPlanDetected?: (msgEl: HTMLElement, plan: import('../rendering/orchestratorPlanParser').OrchestratorPlan) => void;
  /** Called when a worker tab's stream finishes. Provides the final assistant message text. */
  onWorkerDone?: (result: string, isError: boolean) => void;
```

- [ ] **Step 4: Add imports to StreamController**

At the top of `src/features/chat/controllers/StreamController.ts`, add:

```typescript
import { extractOrchestratorPlan } from '../rendering/orchestratorPlanParser';
```

- [ ] **Step 5: Hook plan detection into the `done` handler**

In `StreamController.handleStreamChunk`, find the `case 'done':` block. After any existing finalization (flushing text, finalizing thinking blocks, etc.), add:

```typescript
      // Orchestrator plan detection
      if (this.deps.onOrchestratorPlanDetected && msg.content) {
        const plan = extractOrchestratorPlan(msg.content);
        if (plan) {
          const msgEl = this.deps.renderer.getMessageEl(msg.id);
          if (msgEl) {
            this.deps.onOrchestratorPlanDetected(msgEl, plan);
          }
        }
      }
      // Worker done-reporting
      if (this.deps.onWorkerDone) {
        const isError = msg.toolCalls?.some((tc) => tc.status === 'error') ?? false;
        this.deps.onWorkerDone(msg.content, isError);
      }
```

- [ ] **Step 6: Run typecheck**

```
npm run typecheck
```

Expected: No new errors.

- [ ] **Step 7: Commit**

```bash
git add src/features/chat/controllers/StreamController.ts \
        tests/unit/features/chat/controllers/StreamController.orchestrator.test.ts
git commit -m "feat: wire orchestrator plan detection and worker done-reporting in StreamController"
```

---

### Task 7: System prompt injection

**Files:**
- Modify: `src/core/prompt/mainAgent.ts`
- Create: `tests/unit/core/prompt/mainAgent.orchestrator.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/core/prompt/mainAgent.orchestrator.test.ts`:

```typescript
import { buildSystemPrompt } from '@/core/prompt/mainAgent';

describe('buildSystemPrompt orchestrator mode', () => {
  it('does not include the orchestrator section when orchestratorMode is absent', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).not.toContain('orchestrator_plan');
  });

  it('includes the orchestrator section when orchestratorMode is true', () => {
    const prompt = buildSystemPrompt({}, { orchestratorMode: true });
    expect(prompt).toContain('orchestrator_plan');
    expect(prompt).toContain('"type": "orchestrator_plan"');
  });

  it('does not include the orchestrator section when orchestratorMode is false', () => {
    const prompt = buildSystemPrompt({}, { orchestratorMode: false });
    expect(prompt).not.toContain('orchestrator_plan');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```
npm run test -- --selectProjects unit --testPathPattern mainAgent.orchestrator
```

Expected: FAIL — `orchestratorMode` option not accepted yet.

- [ ] **Step 3: Add the orchestrator prompt constant and wire it**

In `src/core/prompt/mainAgent.ts`:

1. Add the constant before `buildSystemPrompt`:

```typescript
const ORCHESTRATOR_SYSTEM_PROMPT = `## Orchestrator Mode

You are running in Orchestrator Mode. When the user gives you a goal that can be broken into independent parallel tasks, decompose it and emit a plan block for approval **before** doing any work.

**Plan format** — emit exactly one fenced JSON block:

\`\`\`json
{
  "type": "orchestrator_plan",
  "tasks": [
    { "id": "1", "description": "Short task label", "prompt": "Full instructions for this worker." },
    { "id": "2", "description": "Another task", "prompt": "Full instructions for this worker." }
  ]
}
\`\`\`

Rules:
- 2–5 tasks maximum. Each task must be independently executable.
- Do NOT start any work before the user approves the plan.
- After all workers report back, synthesize their results into a final response.`;
```

2. Add `orchestratorMode?: boolean` to `SystemPromptBuildOptions`:

```typescript
export interface SystemPromptBuildOptions {
  appendices?: string[];
  orchestratorMode?: boolean;
}
```

3. In `buildSystemPrompt`, append the orchestrator section when the flag is set. After the `getAppendixSections` line:

```typescript
  if (options.orchestratorMode) {
    prompt += `\n\n${ORCHESTRATOR_SYSTEM_PROMPT}`;
  }
```

- [ ] **Step 4: Run tests to confirm they pass**

```
npm run test -- --selectProjects unit --testPathPattern mainAgent.orchestrator
```

Expected: All 3 tests PASS.

- [ ] **Step 5: Run the full unit suite to check for regressions**

```
npm run test -- --selectProjects unit
```

Expected: All tests pass.

- [ ] **Step 6: Find where providers call `buildSystemPrompt` and pass the flag**

```
grep -rn "buildSystemPrompt" src/providers/
```

For each call site found, check whether the calling code has access to the current `Conversation`. If so, add `orchestratorMode: conversation?.orchestratorMode` to the options argument. The options argument is either the second parameter directly or via a spread — find the pattern and add the field in-place.

- [ ] **Step 7: Commit**

```bash
git add src/core/prompt/mainAgent.ts \
        tests/unit/core/prompt/mainAgent.orchestrator.test.ts
git commit -m "feat: inject orchestrator system prompt when orchestratorMode is active"
```

---

### Task 8: TabManager.createWorkerTab

**Files:**
- Modify: `src/features/chat/tabs/TabManager.ts`

- [ ] **Step 1: Add `bypassTabLimit` to `CreateTabOptions`**

`CreateTabOptions` is defined at the top of `TabManager.ts` (not in `types.ts`). Add the new field:

```typescript
type CreateTabOptions = {
  activate?: boolean;
  draftModel?: string;
  bypassTabLimit?: boolean;
};
```

- [ ] **Step 2: Respect the bypass flag in `createTab`**

In `createTab`, find the limit check:

```typescript
    const maxTabs = this.getMaxTabs();
    if (this.tabs.size >= maxTabs) {
      return null;
    }
```

Replace it with:

```typescript
    const maxTabs = this.getMaxTabs();
    if (this.tabs.size >= maxTabs && !options.bypassTabLimit) {
      return null;
    }
```

- [ ] **Step 3: Add `createWorkerTab` method**

After `createTab`, add:

```typescript
  /**
   * Creates a worker tab for an orchestrator, bypassing the max-tab limit.
   * Sets orchestratorTabId on the new tab and registers it on the orchestrator tab.
   */
  async createWorkerTab(orchestratorTabId: TabId): Promise<TabData | null> {
    const tab = await this.createTab(undefined, undefined, {
      activate: false,
      bypassTabLimit: true,
    });
    if (!tab) return null;

    tab.orchestratorTabId = orchestratorTabId;
    const orchestratorTab = this.tabs.get(orchestratorTabId);
    if (orchestratorTab) {
      orchestratorTab.workerTabIds = orchestratorTab.workerTabIds ?? [];
      orchestratorTab.workerTabIds.push(tab.id);
    }
    return tab;
  }
```

- [ ] **Step 4: Run typecheck**

```
npm run typecheck
```

Expected: No new errors.

- [ ] **Step 5: Run unit tests**

```
npm run test -- --selectProjects unit
```

Expected: All existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/features/chat/tabs/TabManager.ts
git commit -m "feat: add TabManager.createWorkerTab that bypasses the tab limit"
```

---

### Task 9: Orchestrator mode toggle and tab bar badges

**Files:**
- Modify: `src/features/chat/tabs/TabBar.ts`
- Modify: `src/features/chat/tabs/types.ts`

- [ ] **Step 1: Add `isOrchestrator` and `isWorker` to `TabBarItem`**

In `src/features/chat/tabs/types.ts`, find `TabBarItem` and add two optional fields:

```typescript
  /** True when this tab is an orchestrator tab. */
  isOrchestrator?: boolean;
  /** True when this tab is a worker tab (spawned by an orchestrator). */
  isWorker?: boolean;
```

- [ ] **Step 2: Prefix orchestrator and worker tab titles in TabBar**

In `src/features/chat/tabs/TabBar.ts`, find `renderBadge(item: TabBarItem)`. Locate where the badge label/title is set. Before setting the title text, add a prefix:

```typescript
    let displayTitle = item.title;
    if (item.isOrchestrator) {
      displayTitle = `⚡ ${item.title}`;
    } else if (item.isWorker) {
      const workerSuffix = item.isStreaming ? ' ◌' : item.needsAttention ? ' ?' : ' ✓';
      displayTitle = item.title + workerSuffix;
    }
```

Use `displayTitle` wherever the badge label text is assigned.

- [ ] **Step 3: Populate `isOrchestrator`/`isWorker` in TabManager.getTabBarItems**

In `src/features/chat/tabs/TabManager.ts`, find `getTabBarItems()`. In the loop where `TabBarItem` objects are constructed, add:

```typescript
        isOrchestrator: tab.workerTabIds != null && tab.workerTabIds.length > 0,
        isWorker: tab.orchestratorTabId != null,
```

- [ ] **Step 4: Add the orchestrator mode toggle button in InputToolbar**

First, grep for the Plan Mode toggle to understand the pattern:

```
grep -n "planMode\|ModeSelector\|mode-selector" src/features/chat/ui/InputToolbar.ts | head -20
```

Following the exact same pattern as the Plan Mode toggle, add an orchestrator mode button:
- Button class: `claudian-orchestrator-toggle`
- Tooltip (via `setTooltip`): `'Orchestrator mode'`
- Icon (via `setIcon`): `'git-fork'`
- Active state: add/remove the `is-active` CSS class based on `conversation?.orchestratorMode === true`
- Click handler: toggle `conversation.orchestratorMode = !(conversation?.orchestratorMode ?? false)`, then call `plugin.saveConversation(conversation)` and refresh the button's active class

- [ ] **Step 5: Run typecheck**

```
npm run typecheck
```

Expected: No new errors.

- [ ] **Step 6: Commit**

```bash
git add src/features/chat/tabs/TabBar.ts \
        src/features/chat/tabs/types.ts \
        src/features/chat/tabs/TabManager.ts \
        src/features/chat/ui/InputToolbar.ts
git commit -m "feat: add orchestrator/worker tab bar badges and orchestrator mode toggle"
```

---

### Task 10: Wire everything in ClaudianView

**Files:**
- Modify: `src/features/chat/ClaudianView.ts`

- [ ] **Step 1: Import new types and classes**

At the top of `src/features/chat/ClaudianView.ts`, add imports:

```typescript
import { OrchestratorService } from './services/OrchestratorService';
import { InlineOrchestratorPlan } from './rendering/InlineOrchestratorPlan';
import type { OrchestratorPlan } from './rendering/orchestratorPlanParser';
```

- [ ] **Step 2: Create `OrchestratorService` instance**

In `ClaudianView.onOpen()` (or wherever `TabManager` is created), after creating `this.tabManager`, create the service:

```typescript
this.orchestratorService = new OrchestratorService({
  sendToTab: (tabId, message) => {
    const tab = this.tabManager.getTab(tabId);
    if (!tab) return;
    const inputEl = tab.dom.inputEl;
    inputEl.value = message;
    tab.controllers.inputController?.sendMessage();
  },
});
```

Declare the field on the class: `private orchestratorService!: OrchestratorService;`

- [ ] **Step 3: Wire `onTabClosed` → `orchestratorService.handleTabClosed`**

In the `TabManagerCallbacks` passed to `TabManager`, add:

```typescript
  onTabClosed: (tabId) => {
    this.orchestratorService.handleTabClosed(tabId);
    // ... existing onTabClosed logic if any
  },
```

- [ ] **Step 4: Thread orchestrator deps through `CreateTabOptions` → `Tab.ts`**

`StreamController` is constructed inside `Tab.ts`'s `createTab()`, not in `ClaudianView` directly. The cleanest way to pass the orchestrator callbacks is to extend `CreateTabOptions` (defined at the top of `TabManager.ts`) with the callbacks, then forward them in `Tab.ts`.

**Step 4a — Add fields to `CreateTabOptions` in `TabManager.ts`:**

```typescript
type CreateTabOptions = {
  activate?: boolean;
  draftModel?: string;
  bypassTabLimit?: boolean;
  onOrchestratorPlanDetected?: (msgEl: HTMLElement, plan: import('../rendering/orchestratorPlanParser').OrchestratorPlan) => void;
  onWorkerDone?: (result: string, isError: boolean) => void;
};
```

**Step 4b — Forward the callbacks from `TabManager.createTab()` to `createTab()` (from `Tab.ts`):**

Inside `TabManager.createTab()`, find the `createTab({ ... })` call from `Tab.ts`. Add the two callbacks to the options object passed to it:

```typescript
      onOrchestratorPlanDetected: options.onOrchestratorPlanDetected,
      onWorkerDone: options.onWorkerDone,
```

**Step 4c — Accept the callbacks in `Tab.ts`'s `createTab` options and wire them to `StreamController`:**

Find the `createTab` function signature in `Tab.ts` (look for the options parameter). Add the two fields. Then, when constructing `StreamControllerDeps`, add:

```typescript
      onOrchestratorPlanDetected: options.onOrchestratorPlanDetected,
      onWorkerDone: options.onWorkerDone,
```

**Step 4d — In `ClaudianView`, pass the callbacks when creating tabs:**

Find where `ClaudianView` calls `this.tabManager.createTab(...)`. Change it to pass a factory for the callbacks. Since callbacks reference the tab ID (which isn't known until after `createTab` returns), use the returned tab:

```typescript
// After creating a tab, patch its StreamController deps via an init hook.
// Alternative: pass a late-binding closure that captures `tab.id` lazily.
```

The cleanest approach given the existing architecture: pass callbacks as closures that use a `tabIdRef` object whose `.current` is set after tab creation:

```typescript
const tabIdRef = { current: '' };
const tab = await this.tabManager.createTab(conversationId, tabId, {
  ...existingOptions,
  onOrchestratorPlanDetected: (msgEl, plan) => {
    const currentTabId = tabIdRef.current;
    if (!currentTabId) return;
    new InlineOrchestratorPlan(msgEl, plan,
      async (tasks) => {
        for (const task of tasks) {
          const workerTab = await this.tabManager.createWorkerTab(currentTabId, {
            onWorkerDone: (result, isError) => {
              this.orchestratorService.reportResult(workerTab.id, result, isError);
            },
          });
          if (!workerTab) continue;
          this.orchestratorService.registerWorker(currentTabId, workerTab.id, task.description);
          workerTab.dom.inputEl.value = task.prompt;
          workerTab.controllers.inputController?.sendMessage();
        }
      },
      () => {},
    ).render();
  },
  onWorkerDone: (result, isError) => {
    const orchId = this.orchestratorService.getOrchestratorTabId(tabIdRef.current);
    if (orchId) this.orchestratorService.reportResult(tabIdRef.current, result, isError);
  },
});
if (tab) tabIdRef.current = tab.id;
```

Apply this pattern wherever `ClaudianView` calls `createTab` (both the initial tab creation and any subsequent calls). Also update `createWorkerTab` to accept an optional extra options object for `onWorkerDone`.

- [ ] **Step 5: Pass `orchestratorMode` to `buildSystemPrompt`**

Search for `buildSystemPrompt` in `src/providers/` (run: `grep -rn "buildSystemPrompt" src/providers/`). For each call site, add `orchestratorMode: conversation?.orchestratorMode` to the options argument. If the call site doesn't have access to the conversation, trace back through the call chain to find where it's available.

- [ ] **Step 6: Run the full test suite**

```
npm run test -- --selectProjects unit
npm run test -- --selectProjects integration
```

Expected: All tests pass.

- [ ] **Step 7: Run the type checker**

```
npm run typecheck
```

Expected: No errors.

- [ ] **Step 8: Commit**

```bash
git add src/features/chat/ClaudianView.ts
git commit -m "feat: wire OrchestratorService, plan approval, and worker reporting in ClaudianView"
```

---

### Task 11: CSS for orchestrator plan widget

**Files:**
- Modify: `styles.css` (or the relevant modular CSS file under `src/style/`)

- [ ] **Step 1: Find where chat-related styles live**

```
grep -rn "claudian-ask-question-inline\|claudian-tab-badge" src/style/ styles.css
```

Add the orchestrator plan styles in the same file:

```css
/* Orchestrator plan approval */
.claudian-orchestrator-plan {
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  padding: var(--size-4-3);
  margin-top: var(--size-4-2);
  background: var(--background-secondary);
}

.claudian-orchestrator-plan h4 {
  margin: 0 0 var(--size-4-2);
  font-size: var(--font-ui-small);
  color: var(--text-normal);
}

.claudian-orchestrator-plan-tasks {
  list-style: none;
  padding: 0;
  margin: 0 0 var(--size-4-3);
}

.claudian-orchestrator-plan-task {
  padding: var(--size-4-1) 0;
  font-size: var(--font-ui-small);
  color: var(--text-muted);
  border-bottom: 1px solid var(--background-modifier-border);
}

.claudian-orchestrator-plan-task:last-child {
  border-bottom: none;
}

.claudian-orchestrator-plan-actions {
  display: flex;
  gap: var(--size-4-2);
  margin-top: var(--size-4-3);
}
```

- [ ] **Step 2: Commit**

```bash
git add styles.css src/style/
git commit -m "feat: add CSS for orchestrator plan approval widget"
```
