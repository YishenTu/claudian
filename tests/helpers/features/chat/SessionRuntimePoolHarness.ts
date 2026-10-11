import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { createChatSessionRuntime } from '@/features/chat/sessions/createChatSessionRuntime';
import { SessionRuntimePool } from '@/features/chat/sessions/SessionRuntimePool';

const pools: SessionRuntimePool[] = [];

/** Real session ownership for view fixtures; persistence remains their supplied application port. */
export function installSessionRuntimePool(plugin: ChatFeatureHost, options: { onChanged?: () => void } = {}): SessionRuntimePool {
  const pool = new SessionRuntimePool({
    createRuntime: identity => createChatSessionRuntime(plugin, identity),
    releaseHistory: async (_id, canRelease) => canRelease(),
    onChanged: options.onChanged ?? (() => undefined),
    onError: () => undefined,
  });
  Object.assign(plugin, { sessionRuntimes: pool });
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.allSettled(pools.splice(0).map(pool => pool.dispose()));
});
