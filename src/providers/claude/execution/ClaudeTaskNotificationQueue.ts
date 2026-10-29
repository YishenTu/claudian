import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { parseClaudeTaskNotification } from '../normalization/claudeTaskNotification';

/** Bridges completion edges to transcript boundaries, including SDK turns without user echoes. */
export class ClaudeTaskNotificationQueue {
  private readonly backgroundModes = new Map<string, boolean>();
  private readonly pending = new Map<string, { content: string }>();
  private turnNotifications = new Map<string, { content: string }>();
  private liveBackgroundTasks = new Set<string>();

  observe(message: SDKMessage): void {
    if (message.type !== 'system') return;
    if (message.subtype === 'init') {
      // The synthetic prompt has been selected before init. Completions that
      // arrive during API latency belong to a later consumption boundary.
      this.turnNotifications = new Map(this.pending);
    } else if (message.subtype === 'task_started' && message.is_backgrounded !== undefined) {
      this.backgroundModes.set(message.task_id, message.is_backgrounded);
    } else if (message.subtype === 'task_updated' && message.patch.is_backgrounded !== undefined) {
      this.backgroundModes.set(message.task_id, message.patch.is_backgrounded);
    } else if (message.subtype === 'background_tasks_changed') {
      // A level signal: replacing the set keeps a missed task_notification from leaving a task running.
      this.liveBackgroundTasks = new Set(message.tasks.filter(task => !task.ambient).map(task => task.task_id));
    }
  }

  /** The CLI process runs a non-ambient background task (shell, monitor or agent). */
  hasLiveBackgroundTask(): boolean {
    return this.liveBackgroundTasks.size > 0;
  }

  complete(message: SDKMessage, content: string | undefined): void {
    if (message.type !== 'system' || message.subtype !== 'task_notification') return;
    const foreground = this.backgroundModes.get(message.task_id) === false;
    this.backgroundModes.delete(message.task_id);
    if (!foreground && !message.skip_transcript && content) this.pending.set(message.task_id, { content });
  }

  consume(content: unknown): string | null {
    const notification = parseClaudeTaskNotification(content);
    if (!notification) return null;
    this.pending.delete(notification.taskId);
    this.turnNotifications.delete(notification.taskId);
    return notification.content;
  }

  takeTurnNotifications(): string[] {
    const contents: string[] = [];
    for (const [taskId, notification] of this.turnNotifications) {
      contents.push(notification.content);
      if (this.pending.get(taskId) === notification) this.pending.delete(taskId);
    }
    this.turnNotifications.clear();
    return contents;
  }

  reset(): void {
    this.pending.clear();
    this.backgroundModes.clear();
    this.turnNotifications.clear();
    this.liveBackgroundTasks.clear();
  }
}
