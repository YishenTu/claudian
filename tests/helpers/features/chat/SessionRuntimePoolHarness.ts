import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { createChatSessionRuntime } from '@/features/chat/sessions/createChatSessionRuntime';
import { SessionRuntimePool } from '@/features/chat/sessions/SessionRuntimePool';

const pools: SessionRuntimePool[] = [];

interface RuntimePoolFixtureOptions {
  onChanged?: () => void;
  onSessionSettled?: (conversationId: string) => void;
}

/** Real session ownership for view fixtures; persistence remains their supplied application port. */
export function createSessionRuntimePool(
  getHost: () => ChatFeatureHost,
  options: RuntimePoolFixtureOptions = {},
): SessionRuntimePool {
  const pool = new SessionRuntimePool({
    createRuntime: identity => createChatSessionRuntime(getHost(), identity),
    releaseHistory: async (_id, canRelease) => canRelease(),
    onChanged: options.onChanged ?? (() => undefined),
    ...(options.onSessionSettled ? { onSessionSettled: options.onSessionSettled } : {}),
    onError: () => undefined,
  });
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.allSettled(pools.splice(0).map(pool => pool.dispose()));
});
