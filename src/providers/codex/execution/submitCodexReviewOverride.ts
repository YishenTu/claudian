import { watch } from 'node:fs/promises';

import type { GuardianReviewCompleted } from '../runtime/codexAppServerTypes';
import type { CodexRPCTransport } from '../runtime/CodexRPCTransport';
import { guardianOverrideParams } from '../runtime/notifications/codexAutoReview';

/** Codex acknowledges the queued override before appending its context to an idle rollout. */
export async function submitCodexReviewOverride(
  transport: CodexRPCTransport,
  denial: GuardianReviewCompleted,
  idleRollout: string | null,
): Promise<void> {
  const params = guardianOverrideParams(denial);
  if (!idleRollout) {
    await transport.request('thread/approveGuardianDeniedAction', params);
    return;
  }

  const controller = new AbortController();
  const change = observeRolloutChange(idleRollout, controller.signal);
  try {
    await transport.request('thread/approveGuardianDeniedAction', params);
    // A mapped or removed rollout may never deliver a filesystem event.
    const timeout = window.setTimeout(() => controller.abort(), 5_000);
    try {
      await change;
    } finally {
      window.clearTimeout(timeout);
    }
  } finally {
    controller.abort();
  }
}

async function observeRolloutChange(path: string, signal: AbortSignal): Promise<void> {
  try {
    for await (const event of watch(path, { signal, persistent: false })) {
      if (event.eventType === 'change') return;
    }
  } catch {
    // The native RPC remains authoritative when the host cannot watch the file.
  }
}
