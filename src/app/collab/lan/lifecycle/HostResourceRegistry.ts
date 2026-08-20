import { randomUUID } from 'node:crypto';

import { isCollabMemberId, isCollabProjectId } from '@claudian/collab-protocol';

import { CollabError } from '@/core/collab/ClaudianCollabError';

const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;

export type HostResourceCloseReason =
  | 'access-removed'
  | 'host-stopped'
  | 'pending-expired'
  | 'project-stopped';

export type HostResourceCloser = (
  reason: HostResourceCloseReason,
) => void | Promise<void>;

export interface HostResourceRegistryOptions {
  readonly closeTimeoutMs?: number;
}

interface HostOwnedResource {
  readonly close: HostResourceCloser;
  readonly id: string;
  readonly memberId: string;
  readonly projectId: string;
}

type CloseOutcome = 'closed' | 'failed' | 'timed-out';

function resourceError(
  code: 'operation-failed' | 'operation-timeout',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: ['open-diagnostics'],
    safeContext: { reason },
  });
}

export class HostResourceRegistry {
  private readonly closeTimeoutMs: number;
  private readonly resources = new Map<string, HostOwnedResource>();

  constructor(options: HostResourceRegistryOptions = {}) {
    this.closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.closeTimeoutMs) || this.closeTimeoutMs < 1) {
      throw resourceError('operation-failed', 'host-resource-timeout-invalid');
    }
  }

  get size(): number {
    return this.resources.size;
  }

  register(
    projectId: string,
    memberId: string,
    close: HostResourceCloser,
  ): () => void {
    if (!isCollabProjectId(projectId) || !isCollabMemberId(memberId)) {
      throw resourceError('operation-failed', 'host-resource-identity-invalid');
    }
    const id = randomUUID();
    this.resources.set(id, { close, id, memberId, projectId });
    return () => {
      this.resources.delete(id);
    };
  }

  closeMember(
    projectId: string,
    memberId: string,
    reason: Extract<HostResourceCloseReason, 'access-removed' | 'pending-expired'>,
  ): Promise<void> {
    return this.closeMatching(resource => (
      resource.projectId === projectId && resource.memberId === memberId
    ), reason);
  }

  closeProject(
    projectId: string,
    reason: Extract<HostResourceCloseReason, 'project-stopped'>,
  ): Promise<void> {
    return this.closeMatching(resource => resource.projectId === projectId, reason);
  }

  closeAll(
    reason: Extract<HostResourceCloseReason, 'host-stopped'>,
  ): Promise<void> {
    return this.closeMatching(() => true, reason);
  }

  private closeMatching(
    matches: (resource: HostOwnedResource) => boolean,
    reason: HostResourceCloseReason,
  ): Promise<void> {
    const selected = [...this.resources.values()].filter(matches);
    for (const resource of selected) this.resources.delete(resource.id);
    const closings = selected.map(resource => this.closeOne(resource, reason));
    return Promise.all(closings).then(outcomes => {
      if (outcomes.includes('timed-out')) {
        throw resourceError('operation-timeout', 'host-resource-close-timeout');
      }
      if (outcomes.includes('failed')) {
        throw resourceError('operation-failed', 'host-resource-close-failed');
      }
    });
  }

  private closeOne(
    resource: HostOwnedResource,
    reason: HostResourceCloseReason,
  ): Promise<CloseOutcome> {
    let result: void | Promise<void>;
    try {
      result = resource.close(reason);
    } catch {
      return Promise.resolve('failed');
    }
    if (!result) return Promise.resolve('closed');
    return new Promise(resolve => {
      let settled = false;
      const finish = (outcome: CloseOutcome) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(outcome);
      };
      const timer = window.setTimeout(() => finish('timed-out'), this.closeTimeoutMs);
      void Promise.resolve(result).then(
        () => finish('closed'),
        () => finish('failed'),
      );
    });
  }
}
