import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { createChatSessionRuntime } from '@/features/chat/sessions/createChatSessionRuntime';
import { SessionRuntimePool } from '@/features/chat/sessions/SessionRuntimePool';

const pools: SessionRuntimePool[] = [];

export type RuntimePoolFixtureOptions = Partial<Pick<
  ConstructorParameters<typeof SessionRuntimePool>[0],
  'onChanged' | 'onSessionSettled' | 'releaseHistory' | 'onError' | 'retainedDetachedSessions'
>>;

/** Real session ownership for view fixtures; persistence remains their supplied application port. */
export function createSessionRuntimePool(
  getHost: () => ChatFeatureHost,
  options: RuntimePoolFixtureOptions = {},
): SessionRuntimePool {
  const pool = new SessionRuntimePool({
    createRuntime: identity => createChatSessionRuntime(getHost(), identity),
    releaseHistory: options.releaseHistory ?? (async (_id, canRelease) => canRelease()),
    retainedDetachedSessions: options.retainedDetachedSessions,
    onChanged: options.onChanged ?? (() => undefined),
    ...(options.onSessionSettled ? { onSessionSettled: options.onSessionSettled } : {}),
    onError: options.onError ?? (() => undefined),
  });
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.allSettled(pools.splice(0).map(pool => pool.dispose()));
});
