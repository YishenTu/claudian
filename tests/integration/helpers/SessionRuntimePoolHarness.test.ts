/** @vitest-environment jsdom */
import { registerChatTestProvider } from '@test/helpers/features/chat/ChatProviderFixture';
import { createSessionRuntimePool } from '@test/helpers/features/chat/SessionRuntimePoolHarness';
import { createPlugin } from '@test/helpers/features/chat/TabManagerIntegrationHarness';

import type { SessionRuntimePool } from '@/features/chat/sessions/SessionRuntimePool';

it('retains the configured session budget and reports a guarded history-release failure', async () => {
  registerChatTestProvider('claude', { models: [{ value: 'claude-default', label: 'Claude' }] });
  const failure = new Error('History release failed');
  const releases: Array<{ id: string; allowed: boolean }> = [];
  const errors: unknown[] = [];
  const options = {
    retainedDetachedSessions: 1,
    releaseHistory: async (id, canRelease) => {
      releases.push({ id, allowed: canRelease() });
      throw failure;
    },
    onError: error => { errors.push(error); },
  } satisfies Partial<ConstructorParameters<typeof SessionRuntimePool>[0]>;
  const pool = createSessionRuntimePool(() => host, options);
  const host = await createPlugin({ sessionRuntimes: pool });
  const first = pool.acquire({ conversationId: 'first', providerId: 'claude', draftModel: null }, { reveal() {} }).attachment;
  const firstModel = first.runtime.model;
  pool.release(first);
  // Detach has scheduled any eviction; observe whether it incorrectly releases a retained model.
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(first.runtime.peekModel === firstModel).toBe(true);
  expect(releases).toEqual([]);

  const second = pool.acquire({ conversationId: 'second', providerId: 'claude', draftModel: null }, { reveal() {} }).attachment;
  const secondModel = second.runtime.model;
  pool.release(second);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(releases).toEqual([{ id: 'first', allowed: true }]);
  expect(errors).toEqual([failure]);
  expect(first.runtime.peekModel === firstModel).toBe(true);
  expect(second.runtime.peekModel === secondModel).toBe(true);
});
