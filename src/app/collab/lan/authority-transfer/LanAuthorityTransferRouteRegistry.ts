import { type CollabProjectId } from '@claudian-collab/protocol';

import type {
  LanAuthorityTransferRouteAccess,
  LanAuthorityTransferRouteAdmissionResult,
  LanAuthorityTransferRouteRegistration,
  LanAuthorityTransferRouteTransition,
} from '@/app/collab/lan/authority-transfer/LanAuthorityTransferRouter';
import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';
import { CollabError } from '@/core/collab/ClaudianCollabError';

function routeStateError(reason: string): CollabError {
  return new CollabError({
    code: 'durable-progress-recovery-required',
    recoveryActions: ['resume', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function transferId(registration: LanAuthorityTransferRouteRegistration): string | null {
  return registration.state === 'source-active' ? null : registration.transferId;
}

function routeKey(projectId: CollabProjectId, id: string | null): string {
  return `${projectId}\0${id ?? ''}`;
}

function assertTransition(input: LanAuthorityTransferRouteTransition): void {
  const { expected, next, relinquishmentProof: proof } = input;
  const directionMatches = expected.state === 'source-active' && next.state === 'terminal-source'
    ? proof.sourceAuthority.kind === 'lan' && proof.targetAuthority.kind === 'cloud'
    : expected.state === 'target-only-staged' && next.state === 'target-active'
      ? proof.sourceAuthority.kind === 'cloud' && proof.targetAuthority.kind === 'lan'
      : false;
  if (
    !directionMatches
    || (expected.authorityGeneration !== undefined && expected.authorityGeneration !== (
      expected.state === 'source-active' ? proof.sourceAuthority.generation : proof.targetAuthority.generation
    ))
    || (next.authorityGeneration !== undefined && next.authorityGeneration !== (
      next.state === 'terminal-source' ? proof.sourceAuthority.generation : proof.targetAuthority.generation
    ))
    || expected.projectId !== next.projectId
    || proof.projectId !== next.projectId
    || proof.transferId !== transferId(next)
    || (transferId(expected) !== null && transferId(expected) !== transferId(next))
  ) throw routeStateError('authority-transfer-route-transition-invalid');
}

export class LanAuthorityTransferRouteRegistry implements LanAuthorityTransferRouteAccess {
  private closed = false;
  private readonly queues = new Map<CollabProjectId, SerialTaskQueue>();
  private readonly registrations = new Map<
    string,
    LanAuthorityTransferRouteRegistration
  >();

  get size(): number {
    return this.registrations.size;
  }

  listProjectIds(): readonly CollabProjectId[] {
    return [...new Set([...this.registrations.values()].map(route => route.projectId))];
  }

  resolve(projectId: CollabProjectId, id?: string): LanAuthorityTransferRouteRegistration | null {
    if (this.closed) return null;
    if (id !== undefined) {
      return this.registrations.get(routeKey(projectId, id)) ?? null;
    }
    return this.registrations.get(routeKey(projectId, null))
      ?? [...this.registrations.values()].reverse().find(route => route.projectId === projectId)
      ?? null;
  }

  runIfCurrent<T>(
    projectId: CollabProjectId,
    expected: LanAuthorityTransferRouteRegistration,
    operation: () => Promise<T>,
  ): Promise<LanAuthorityTransferRouteAdmissionResult<T>> {
    if (this.closed) return Promise.resolve({ admitted: false });
    return this.queue(projectId).run(async () => {
      if (this.closed || this.registrations.get(routeKey(projectId, transferId(expected))) !== expected) {
        return { admitted: false };
      }
      return { admitted: true, value: await operation() };
    });
  }

  install(registration: LanAuthorityTransferRouteRegistration): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Authority-transfer routes are closed'));
    return this.queue(registration.projectId).run(async () => {
      if (this.closed) throw new Error('Authority-transfer routes are closed');
      const key = routeKey(registration.projectId, transferId(registration));
      const current = this.registrations.get(key);
      if (current && current !== registration) {
        throw routeStateError('authority-transfer-route-conflict');
      }
      if (registration.authorityGeneration !== undefined
        && (!Number.isSafeInteger(registration.authorityGeneration) || registration.authorityGeneration < 1)) {
        throw routeStateError('authority-transfer-route-conflict');
      }
      for (const route of this.registrations.values()) {
        if (route.projectId !== registration.projectId) continue;
        const source = registration.state === 'source-active' ? registration
          : route.state === 'source-active' ? route : null;
        const terminal = registration.state === 'terminal-source' ? registration
          : route.state === 'terminal-source' ? route : null;
        if (source && terminal && (source.authorityGeneration === undefined
          || terminal.authorityGeneration === undefined
          || terminal.authorityGeneration >= source.authorityGeneration)) {
          throw routeStateError('authority-transfer-route-conflict');
        }
      }
      if ([...this.registrations.values()].some(route => (
        route.projectId === registration.projectId
        && route !== registration
        && (route.state === 'source-active' || route.state === 'target-only-staged')
        && (registration.state === 'source-active' || registration.state === 'target-only-staged')
      ))) throw routeStateError('authority-transfer-route-conflict');
      this.registrations.set(key, registration);
    });
  }

  transition(input: LanAuthorityTransferRouteTransition): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Authority-transfer routes are closed'));
    assertTransition(input);
    return this.queue(input.next.projectId).run(async () => {
      if (this.closed) throw new Error('Authority-transfer routes are closed');
      const previousKey = routeKey(input.expected.projectId, transferId(input.expected));
      const nextKey = routeKey(input.next.projectId, transferId(input.next));
      if (this.registrations.get(previousKey) !== input.expected) {
        throw routeStateError('authority-transfer-route-stale');
      }
      if (nextKey !== previousKey && this.registrations.has(nextKey)) {
        throw routeStateError('authority-transfer-route-conflict');
      }
      this.registrations.delete(previousKey);
      this.registrations.set(nextKey, input.next);
    });
  }

  remove(
    projectId: CollabProjectId,
    expectedState?: LanAuthorityTransferRouteRegistration['state'],
    id?: string,
  ): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    return this.queue(projectId).run(async () => {
      const current = id !== undefined
        ? this.registrations.get(routeKey(projectId, id))
        : expectedState === 'source-active'
          ? this.registrations.get(routeKey(projectId, null))
          : this.resolve(projectId);
      if (!current || (expectedState && current.state !== expectedState)) return false;
      this.registrations.delete(routeKey(projectId, transferId(current)));
      return true;
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.queues.values()].map(queue => queue.drain()));
    this.registrations.clear();
  }

  private queue(projectId: CollabProjectId): SerialTaskQueue {
    let queue = this.queues.get(projectId);
    if (!queue) {
      queue = new SerialTaskQueue();
      this.queues.set(projectId, queue);
    }
    return queue;
  }
}
