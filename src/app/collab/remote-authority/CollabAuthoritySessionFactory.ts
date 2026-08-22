import type { CollabLocalMembershipRecord } from '@/app/collab/CollabLocalProjectRepository';
import type {
  CollabAuthorityAdapter,
  CollabAuthoritySession,
} from '@/app/collab/remote-authority/CollabAuthoritySession';
import { CollabError } from '@/core/collab/ClaudianCollabError';

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export class CollabAuthoritySessionFactory {
  private readonly adapters: ReadonlyMap<string, CollabAuthorityAdapter>;

  constructor(adapters: readonly CollabAuthorityAdapter[]) {
    const byKind = new Map(adapters.map(adapter => [adapter.authorityKind, adapter]));
    if (byKind.size !== adapters.length) {
      throw new TypeError('Duplicate Collab authority adapter');
    }
    this.adapters = byKind;
  }

  create(membership: CollabLocalMembershipRecord): Promise<CollabAuthoritySession> {
    const adapter = this.adapters.get(membership.authority.kind);
    if (!adapter) {
      return Promise.reject(new CollabError({
        code: 'operation-failed',
        safeContext: { reason: 'collab-authority-adapter-unavailable' },
      }));
    }
    const frozen = deepFreeze(structuredClone(membership));
    return adapter.create(frozen);
  }
}
