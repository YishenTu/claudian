import type { ProviderToolPolicy } from '@/core/execution';
import { isTokenCount } from '@/core/types';
import type {
  ThreadStatusChangedNotification,
  TurnCompletedNotification,
  TurnStartedNotification,
} from '@/providers/codex/runtime/codexAppServerTypes';
import type { CodexNotificationRouter } from '@/providers/codex/runtime/CodexNotificationRouter';

import type { CodexActiveRun, TurnCompletion } from './CodexActiveRun';
import type { CodexCompletionRecovery } from './CodexCompletionRecovery';
import type { CodexExecutionServerRequestRouter } from './CodexExecutionServerRequestRouter';

export interface CodexTurnBindingHost {
  activeRun(): CodexActiveRun | null;
  /** A native turn proves the thread holds the conversation's native context. */
  markNativeContextEstablished(active: CodexActiveRun): void;
}

/**
 * Binds the active run to its native turn and admits that turn's notifications.
 *
 * Notifications can precede the turn-start response, so notifications arriving before
 * the native turn is known are buffered and replayed through the same fence once a
 * `turn/started` event, a scoped notification, or the response identifies the turn.
 */
export class CodexTurnBinding {
  #router: CodexNotificationRouter | null = null;
  #pendingNotifications: Array<{ method: string; params: unknown }> = [];
  #toolPolicy: ProviderToolPolicy | null = null;

  constructor(
    private readonly host: CodexTurnBindingHost,
    private readonly serverRequests: CodexExecutionServerRequestRouter,
    private readonly recovery: CodexCompletionRecovery,
  ) {}

  /** The tool policy native server requests of the next bound turn are checked against. */
  setToolPolicy(toolPolicy: ProviderToolPolicy): void {
    this.#toolPolicy = toolPolicy;
  }

  /** Starts projecting the run's turn; earlier buffered notifications belong to no turn. */
  begin(router: CodexNotificationRouter): void {
    this.#router = router;
    router.beginTurn();
    this.#pendingNotifications = [];
  }

  release(): void {
    this.#router?.endTurn();
    this.#router = null;
    this.#pendingNotifications = [];
    this.#toolPolicy = null;
  }

  /** Returns whether the native turn belongs to the active run, binding it on first sight. */
  observe(threadId: string, nativeTurnId: string): boolean {
    const active = this.host.activeRun();
    if (
      !active
      || active.run.isTerminal
      || active.run.isCancellationRequested
      || active.nativeThreadId !== threadId
    ) {
      return false;
    }
    if (active.nativeTurnId && active.nativeTurnId !== nativeTurnId) {
      return false;
    }
    this.host.markNativeContextEstablished(active);
    if (!active.nativeTurnId) {
      active.nativeTurnId = nativeTurnId;
      this.serverRequests.setActiveTurn({
        localTurnId: active.run.turnId,
        nativeThreadId: threadId,
        nativeTurnId,
        toolPolicy: this.#toolPolicy ?? { kind: 'provider-default' },
      });
      active.run.emit({
        type: 'turn_started',
        accepted: true,
        nativeTurnId,
      });
      this.#flushPendingNotifications(active);
      this.recovery.turnObserved(active);
    }
    return true;
  }

  /** Admits a parent-thread notification for the active run. */
  handleNotification(method: string, params: unknown): void {
    const active = this.host.activeRun();
    if (!active || active.run.isTerminal || active.run.isCancellationRequested) return;
    if (method === 'turn/started') {
      const started = params as TurnStartedNotification;
      this.observe(started.threadId, started.turn.id);
      return;
    }

    if (method === 'thread/status/changed') {
      const changed = params as ThreadStatusChangedNotification;
      if (changed.threadId !== active.nativeThreadId) return;
      if (changed.status.type === 'idle') {
        this.recovery.observeIdle(active);
      } else {
        this.recovery.cancel();
      }
      return;
    }

    const scope = extractNotificationScope(method, params);
    if (scope) {
      if (!active.nativeTurnId) {
        this.#pendingNotifications.push({ method, params });
        return;
      }
      if (!this.observe(scope.threadId, scope.turnId)) return;
      if (
        scope.threadId !== active.nativeThreadId
        || scope.turnId !== active.nativeTurnId
      ) {
        return;
      }
    } else if (!active.nativeTurnId) {
      this.#pendingNotifications.push({ method, params });
      return;
    }

    if (method === 'turn/completed') {
      this.recovery.cancel();
    }
    this.#deliver(active, method, params);
  }

  #flushPendingNotifications(active: CodexActiveRun): void {
    const pending = this.#pendingNotifications;
    this.#pendingNotifications = [];
    for (const notification of pending) {
      const scope = extractNotificationScope(notification.method, notification.params);
      if (
        scope
        && (
          scope.threadId !== active.nativeThreadId
          || scope.turnId !== active.nativeTurnId
        )
      ) {
        continue;
      }
      this.#deliver(active, notification.method, notification.params);
    }
  }

  #deliver(active: CodexActiveRun, method: string, params: unknown): void {
    captureResponseUsage(active, method, params);
    if (method === 'turn/completed') {
      active.completion = readTurnCompletion(params as TurnCompletedNotification);
    }
    this.#router?.handleNotification(method, params);
  }
}

export function extractNotificationScope(
  method: string,
  params: unknown,
): { threadId: string; turnId: string } | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return null;
  }
  const notification = params as Record<string, unknown>;
  const threadId = normalizeId(notification.threadId);
  if (!threadId) return null;
  if (method === 'turn/completed' || method === 'turn/started') {
    const turn = notification.turn;
    const turnId = turn && typeof turn === 'object' && !Array.isArray(turn)
      ? normalizeId((turn as Record<string, unknown>).id)
      : null;
    return turnId ? { threadId, turnId } : null;
  }
  const turnId = normalizeId(notification.turnId)
    ?? normalizeId(notification.turn_id);
  return turnId ? { threadId, turnId } : null;
}

function readTurnCompletion(completed: TurnCompletedNotification): TurnCompletion {
  return {
    status: completed.turn.status === 'inProgress'
      ? 'failed'
      : completed.turn.status,
    nativeTurnId: completed.turn.id,
    durationMs: completed.turn.durationMs,
    ...(completed.turn.error?.message
      ? { errorMessage: completed.turn.error.message }
      : {}),
  };
}

function captureResponseUsage(active: CodexActiveRun, method: string, params: unknown): void {
  if (method !== 'rawResponse/completed' || !params || typeof params !== 'object') return;
  const response = params as { threadId?: string; turnId?: string; responseId?: string; usage?: { outputTokens?: unknown } };
  if (response.threadId !== active.nativeThreadId || response.turnId !== active.nativeTurnId || !response.responseId) return;
  active.responseTokens.set(response.responseId, isTokenCount(response.usage?.outputTokens) ? response.usage.outputTokens : undefined);
}

function normalizeId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
