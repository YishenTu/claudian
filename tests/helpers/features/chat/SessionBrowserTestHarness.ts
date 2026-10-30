import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { createProjectsFake } from '@test/helpers/features/chat/ProjectsFake';
import { createSessionRuntimePool } from '@test/helpers/features/chat/SessionRuntimePoolHarness';
import { conversationRecord } from '@test/helpers/features/chat/TabManagerTestHarness';
import { App } from 'obsidian';

import type { ConversationMeta } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { ConversationLifecycle, type ConversationLifecycleStore } from '@/features/chat/conversation/ConversationLifecycle';

interface Options {
  conversations?: ConversationMeta[];
  host?: Parameters<typeof createChatFeatureHost>[0];
  store?: Partial<ConversationLifecycleStore>;
  onSessionChanged?: () => void;
}

/** Session-list integration over the real lifecycle and pool; the repository is an in-memory port. */
export async function createSessionBrowserHost(options: Options = {}) {
  const records = options.conversations ?? [];
  const getConversationList = vi.fn(options.host?.getConversationList ?? (() => records));
  const projects = options.host?.projects ?? createProjectsFake();
  const pool = createSessionRuntimePool(() => plugin, { onChanged: options.onSessionChanged });
  const find = (id: string) => getConversationList().find(record => record.id === id);
  const store = {
    ensureAllConversationMetadataLoaded: vi.fn(async () => undefined),
    getConversationList,
    deleteConversation: vi.fn(async (id: string) => {
      const live = getConversationList();
      const index = live.findIndex(record => record.id === id);
      if (index >= 0) live.splice(index, 1);
    }),
    setConversationArchived: vi.fn(async (id: string, isArchived: boolean) => {
      const record = find(id);
      if (record) record.isArchived = isArchived;
    }),
    setConversationsPlacement: vi.fn<ConversationLifecycleStore['setConversationsPlacement']>(async (ids, placement) => {
      for (const id of ids) {
        const record = find(id);
        if (record) Object.assign(record, placement);
      }
    }),
    restoreConversations: vi.fn(async (ids: readonly string[]) => {
      for (const id of ids) {
        const record = find(id);
        if (record) record.isArchived = false;
      }
    }),
    archiveProjectIfEmpty: vi.fn(async (_id: string) => {
      throw new Error('Supply the project archive repository port for this test.');
    }),
    archiveConversationsIf: vi.fn<ConversationLifecycleStore['archiveConversationsIf']>(async (ids, predicate) => {
      let archived = 0;
      for (const id of ids) {
        const record = find(id);
        if (record && predicate(conversationRecord(id, record))) {
          record.isArchived = true;
          archived++;
        }
      }
      return archived;
    }),
    ...options.store,
  } satisfies ConversationLifecycleStore;
  const lifecycle = new ConversationLifecycle({
    sessions: pool, conversations: store, projects,
    views: { getAllViews: () => plugin.getAllViews() },
  });
  const overrides = options.host ?? {};
  const hostOptions = { projects, getConversationList, sessionRuntimes: pool, conversationLifecycle: lifecycle };
  const plugin: ChatFeatureHost = await createChatFeatureHost(overrides.fixture
    ? { ...overrides, ...hostOptions }
    : { ...overrides, app: overrides.app ?? new App(), ...hostOptions });
  return { plugin, pool, store, lifecycle, records };
}
