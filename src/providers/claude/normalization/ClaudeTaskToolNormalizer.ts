import type { TodoItem } from '../../../core/tools/todo';
import { TOOL_TODO_WRITE } from '../../../core/tools/toolNames';
import type { ToolProviderPayload } from '../../../core/types';

const CLAUDE_TASK_TOOL_NAMES = [
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
] as const;

type ClaudeTaskToolName = typeof CLAUDE_TASK_TOOL_NAMES[number];
type TaskStatus = TodoItem['status'];

interface StoredTask extends TodoItem {
  id?: string;
}

interface TaskCallState {
  rawName: ClaudeTaskToolName;
  rawInput: Record<string, unknown>;
  taskKey?: string;
  updateTaskId?: string;
  updateTaskBefore?: StoredTask;
}

export interface NormalizedClaudeTaskToolCall {
  name: typeof TOOL_TODO_WRITE;
  input: {
    todos: Array<TodoItem & { id?: string }>;
  };
  providerPayload: ToolProviderPayload;
}

export interface ClaudeTaskToolResultOptions {
  fallbackContent?: string;
  isError?: boolean;
}

/**
 * Reduces Claude Code's incremental task tools into the full-list TodoWrite
 * snapshots consumed by the provider-neutral chat UI.
 */
export class ClaudeTaskToolNormalizer {
  private readonly calls = new Map<string, TaskCallState>();
  private readonly tasks = new Map<string, StoredTask>();

  normalizeToolUse(
    toolCallId: string,
    rawName: string,
    rawInput: Record<string, unknown>,
  ): NormalizedClaudeTaskToolCall | null {
    if (!isClaudeTaskToolName(rawName)) return null;

    const call = this.getOrCreateCall(toolCallId, rawName);
    call.rawInput = { ...rawInput };

    switch (rawName) {
      case 'TaskCreate':
        this.applyCreate(toolCallId, call, rawInput);
        break;
      case 'TaskUpdate':
        this.applyUpdate(call, rawInput);
        break;
      case 'TaskGet':
      case 'TaskList':
        break;
    }

    return this.buildNormalizedCall(call);
  }

  normalizeToolResult(
    toolCallId: string,
    rawOutput: unknown,
    options: ClaudeTaskToolResultOptions = {},
  ): NormalizedClaudeTaskToolCall | null {
    const call = this.calls.get(toolCallId);
    if (!call) return null;

    const effectiveOutput = rawOutput ?? options.fallbackContent;
    const outputRecord = toRecord(effectiveOutput);
    const failed = options.isError === true || outputRecord?.success === false;

    switch (call.rawName) {
      case 'TaskCreate':
        if (failed) {
          if (call.taskKey) this.tasks.delete(call.taskKey);
        } else {
          this.bindCreatedTask(call, effectiveOutput, options.fallbackContent);
        }
        break;
      case 'TaskUpdate':
        if (failed) {
          this.restoreUpdate(call);
        } else {
          this.applyAuthoritativeUpdate(call, outputRecord);
        }
        break;
      case 'TaskList':
        if (!failed) this.applyTaskList(outputRecord);
        break;
      case 'TaskGet':
        if (!failed) this.applyTaskGet(call, outputRecord);
        break;
    }

    return this.buildNormalizedCall(call, effectiveOutput);
  }

  reset(): void {
    this.calls.clear();
    this.tasks.clear();
  }

  private getOrCreateCall(toolCallId: string, rawName: ClaudeTaskToolName): TaskCallState {
    const existing = this.calls.get(toolCallId);
    if (existing?.rawName === rawName) return existing;

    const call: TaskCallState = {
      rawName,
      rawInput: {},
    };
    this.calls.set(toolCallId, call);
    return call;
  }

  private applyCreate(
    toolCallId: string,
    call: TaskCallState,
    input: Record<string, unknown>,
  ): void {
    const subject = readNonEmptyString(input.subject);
    if (!subject) return;

    const taskKey = call.taskKey ?? `pending:${toolCallId}`;
    call.taskKey = taskKey;
    const current = this.tasks.get(taskKey);
    this.tasks.set(taskKey, {
      ...(current?.id ? { id: current.id } : {}),
      content: subject,
      activeForm: readNonEmptyString(input.activeForm) ?? subject,
      status: current?.status ?? 'pending',
    });
  }

  private applyUpdate(call: TaskCallState, input: Record<string, unknown>): void {
    const taskId = readNonEmptyString(input.taskId);
    if (!taskId) return;

    if (call.updateTaskId !== taskId) {
      call.updateTaskId = taskId;
      call.updateTaskBefore = cloneTask(this.tasks.get(taskId));
    }

    const before = call.updateTaskBefore;
    if (!before) return;

    const status = readTaskUpdateStatus(input.status);
    if (status === 'deleted') {
      this.tasks.delete(taskId);
      return;
    }

    const subject = readNonEmptyString(input.subject);
    const activeForm = readNonEmptyString(input.activeForm);
    this.tasks.set(taskId, {
      ...before,
      ...(subject ? { content: subject } : {}),
      ...(activeForm ? { activeForm } : {}),
      ...(status ? { status } : {}),
    });
  }

  private bindCreatedTask(
    call: TaskCallState,
    output: unknown,
    fallbackContent?: string,
  ): void {
    if (!call.taskKey) return;

    const taskRecord = toRecord(toRecord(output)?.task);
    const taskId = readNonEmptyString(taskRecord?.id)
      ?? extractCreatedTaskId(fallbackContent)
      ?? extractCreatedTaskId(typeof output === 'string' ? output : undefined);
    if (!taskId) return;

    const pendingTask = this.tasks.get(call.taskKey);
    if (!pendingTask) return;

    const subject = readNonEmptyString(taskRecord?.subject);
    const createdTask: StoredTask = {
      ...pendingTask,
      id: taskId,
      ...(subject ? { content: subject } : {}),
    };
    this.replaceTaskKey(call.taskKey, taskId, createdTask);
    call.taskKey = taskId;
  }

  private restoreUpdate(call: TaskCallState): void {
    if (!call.updateTaskId) return;
    if (call.updateTaskBefore) {
      this.tasks.set(call.updateTaskId, cloneTask(call.updateTaskBefore)!);
    } else {
      this.tasks.delete(call.updateTaskId);
    }
  }

  private applyAuthoritativeUpdate(
    call: TaskCallState,
    output: Record<string, unknown> | null,
  ): void {
    const taskId = readNonEmptyString(output?.taskId) ?? call.updateTaskId;
    if (!taskId) return;

    const statusChange = toRecord(output?.statusChange);
    const status = readTaskUpdateStatus(statusChange?.to);
    if (status === 'deleted') {
      this.tasks.delete(taskId);
    } else if (status) {
      const task = this.tasks.get(taskId);
      if (task) this.tasks.set(taskId, { ...task, status });
    }
  }

  private applyTaskList(output: Record<string, unknown> | null): void {
    if (!Array.isArray(output?.tasks)) return;

    const nextTasks = new Map<string, StoredTask>();
    for (const value of output.tasks) {
      const record = toRecord(value);
      const taskId = readNonEmptyString(record?.id);
      const subject = readNonEmptyString(record?.subject);
      const status = readTaskStatus(record?.status);
      if (!taskId || !subject || !status) continue;

      const current = this.tasks.get(taskId);
      nextTasks.set(taskId, {
        id: taskId,
        content: subject,
        activeForm: current?.activeForm ?? subject,
        status,
      });
    }

    this.tasks.clear();
    for (const [taskId, task] of nextTasks) this.tasks.set(taskId, task);
  }

  private applyTaskGet(
    call: TaskCallState,
    output: Record<string, unknown> | null,
  ): void {
    if (!output || !Object.prototype.hasOwnProperty.call(output, 'task')) return;

    const requestedTaskId = readNonEmptyString(call.rawInput.taskId);
    if (output.task === null) {
      if (requestedTaskId) this.tasks.delete(requestedTaskId);
      return;
    }

    const taskRecord = toRecord(output.task);
    const taskId = readNonEmptyString(taskRecord?.id) ?? requestedTaskId;
    const subject = readNonEmptyString(taskRecord?.subject);
    const status = readTaskStatus(taskRecord?.status);
    if (!taskId || !subject || !status) return;

    const current = this.tasks.get(taskId);
    this.tasks.set(taskId, {
      id: taskId,
      content: subject,
      activeForm: current?.activeForm ?? subject,
      status,
    });
  }

  private replaceTaskKey(oldKey: string, newKey: string, task: StoredTask): void {
    const entries = [...this.tasks.entries()];
    this.tasks.clear();
    for (const [key, value] of entries) {
      this.tasks.set(key === oldKey ? newKey : key, key === oldKey ? task : value);
    }
  }

  private buildNormalizedCall(
    call: TaskCallState,
    rawOutput?: unknown,
  ): NormalizedClaudeTaskToolCall {
    const hasRawOutput = rawOutput !== undefined;
    return {
      name: TOOL_TODO_WRITE,
      input: {
        todos: [...this.tasks.values()].map(task => ({ ...task })),
      },
      providerPayload: {
        rawName: call.rawName,
        rawInput: { ...call.rawInput },
        ...(hasRawOutput ? { rawOutput } : {}),
      },
    };
  }
}

function isClaudeTaskToolName(name: string): name is ClaudeTaskToolName {
  return (CLAUDE_TASK_TOOL_NAMES as readonly string[]).includes(name);
}

function readTaskStatus(value: unknown): TaskStatus | null {
  return value === 'pending' || value === 'in_progress' || value === 'completed'
    ? value
    : null;
}

function readTaskUpdateStatus(value: unknown): TaskStatus | 'deleted' | null {
  return value === 'deleted' ? value : readTaskStatus(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function extractCreatedTaskId(content: string | undefined): string | null {
  return content?.match(/Task #([^\s]+) created successfully/i)?.[1] ?? null;
}

function cloneTask(task: StoredTask | undefined): StoredTask | undefined {
  return task ? { ...task } : undefined;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
