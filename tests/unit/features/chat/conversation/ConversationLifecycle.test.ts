import { Notice } from 'obsidian';

import { ConversationLifecycle, type ConversationLifecycleStore } from '@/features/chat/conversation/ConversationLifecycle';

interface FakeTab {
  id: string;
  conversationId: string | null;
  isWorking?: boolean;
}

function createManager(initialTabs: FakeTab[]) {
  const manager = {
    tabs: initialTabs,
    closeTab: jest.fn(async (tabId: string) => {
      manager.tabs = manager.tabs.filter(tab => tab.id !== tabId);
      return true;
    }),
    getTabIdentities: () => manager.tabs,
    isTabWorking: (tabId: string) => manager.tabs.find(tab => tab.id === tabId)?.isWorking ?? false,
    retainTabs: jest.fn(),
    resetConversationTabs: jest.fn().mockResolvedValue(undefined),
  };
  return manager;
}

type FakeManager = ReturnType<typeof createManager>;

function createStore(): jest.Mocked<ConversationLifecycleStore> {
  return {
    deleteConversation: jest.fn().mockResolvedValue(undefined),
    setConversationArchived: jest.fn().mockResolvedValue(undefined),
    setConversationsPinned: jest.fn().mockResolvedValue(undefined),
    restoreConversations: jest.fn().mockResolvedValue(undefined),
    archiveConversationsIf: jest.fn(async (ids, shouldArchive) => (
      ids.filter(id => shouldArchive({ id } as never)).length
    )),
  };
}

function createLifecycle(...managers: Array<FakeManager | null>) {
  const conversations = createStore();
  const views = managers.map(manager => ({ getTabManager: () => manager }));
  const lifecycle = new ConversationLifecycle({
    conversations,
    views: { getAllViews: () => views as never },
  });
  return { lifecycle, conversations };
}

describe('ConversationLifecycle', () => {
  beforeEach(() => {
    (Notice as unknown as jest.Mock).mockClear();
  });

  describe('delete', () => {
    it('judges running by the tabs bound to the target session, not the active tab', async () => {
      const local = createManager([
        { id: 'streaming', conversationId: 'active', isWorking: true },
        { id: 'idle', conversationId: 'idle-session' },
      ]);
      const other = createManager([{ id: 'background', conversationId: 'background-session', isWorking: true }]);
      const { lifecycle, conversations } = createLifecycle(local, null, other);

      await lifecycle.delete(['idle-session', 'background-session', 'closed-session']);

      expect(conversations.deleteConversation.mock.calls).toEqual([['idle-session'], ['closed-session']]);
      expect(Notice).toHaveBeenCalledWith('Skipped 1 session that is running');
    });

    it('refuses a single running session without touching its tabs', async () => {
      const manager = createManager([{ id: 'tab', conversationId: 'running', isWorking: true }]);
      const { lifecycle, conversations } = createLifecycle(manager);

      await lifecycle.delete(['running']);

      expect(conversations.deleteConversation).not.toHaveBeenCalled();
      expect(manager.resetConversationTabs).not.toHaveBeenCalled();
      expect(Notice).toHaveBeenCalledWith('Running sessions cannot be deleted');
    });

    it('resets every view through its tab owner and reports the first failure', async () => {
      const first = createManager([]);
      const second = createManager([]);
      first.resetConversationTabs.mockRejectedValueOnce(new Error('first tab failed'));
      const { lifecycle } = createLifecycle(first, second);

      await expect(lifecycle.resetDeletedConversationTabs('deleted')).rejects.toThrow('first tab failed');

      expect(first.resetConversationTabs).toHaveBeenCalledWith('deleted');
      expect(second.resetConversationTabs).toHaveBeenCalledWith('deleted');
    });
  });

  describe('pin', () => {
    it('pins in one batch and retains only tabs bound to the pinned sessions in every view', async () => {
      const local = createManager([
        { id: 'pinned-tab', conversationId: 'conversation-1' },
        { id: 'other-tab', conversationId: 'conversation-3' },
        { id: 'blank-tab', conversationId: null },
      ]);
      const other = createManager([{ id: 'remote-tab', conversationId: 'conversation-2' }]);
      const { lifecycle, conversations } = createLifecycle(local, other);

      await lifecycle.setPinned(['conversation-1', 'conversation-2'], true);

      expect(conversations.setConversationsPinned).toHaveBeenCalledTimes(1);
      expect(conversations.setConversationsPinned).toHaveBeenCalledWith(['conversation-1', 'conversation-2'], true);
      expect(local.retainTabs).toHaveBeenCalledWith(['pinned-tab']);
      expect(other.retainTabs).toHaveBeenCalledWith(['remote-tab']);
      expect(conversations.setConversationsPinned.mock.invocationCallOrder[0])
        .toBeLessThan(local.retainTabs.mock.invocationCallOrder[0]);
    });

    it('does not retain tabs when unpinning', async () => {
      const manager = createManager([{ id: 'tab', conversationId: 'conversation-1' }]);
      const { lifecycle } = createLifecycle(manager);

      await lifecycle.setPinned(['conversation-1'], false);

      expect(manager.retainTabs).not.toHaveBeenCalled();
    });
  });

  describe('archive', () => {
    it('closes every idle tab of the session in every view before archiving it', async () => {
      const local = createManager([{ id: 'local-tab', conversationId: 'conversation-1' }]);
      const other = createManager([{ id: 'other-tab', conversationId: 'conversation-1' }]);
      const { lifecycle, conversations } = createLifecycle(local, other);

      await lifecycle.setArchived('conversation-1', true);

      expect(local.closeTab).toHaveBeenCalledWith('local-tab');
      expect(other.closeTab).toHaveBeenCalledWith('other-tab');
      expect(conversations.setConversationArchived).toHaveBeenCalledWith('conversation-1', true);
      expect(other.closeTab.mock.invocationCallOrder[0])
        .toBeLessThan(conversations.setConversationArchived.mock.invocationCallOrder[0]);
    });

    it('does not archive or close anything while any bound tab is working', async () => {
      const idle = createManager([{ id: 'idle-tab', conversationId: 'conversation-1' }]);
      const running = createManager([{ id: 'running-tab', conversationId: 'conversation-1', isWorking: true }]);
      const { lifecycle, conversations } = createLifecycle(idle, running);

      await lifecycle.setArchived('conversation-1', true);

      expect(idle.closeTab).not.toHaveBeenCalled();
      expect(running.closeTab).not.toHaveBeenCalled();
      expect(conversations.setConversationArchived).not.toHaveBeenCalled();
      expect(Notice).toHaveBeenCalledWith('Running sessions cannot be archived');
    });

    it('restores an archived session without opening or closing a tab', async () => {
      const manager = createManager([]);
      const { lifecycle, conversations } = createLifecycle(manager);

      await lifecycle.setArchived('conversation-1', false);

      expect(conversations.setConversationArchived).toHaveBeenCalledWith('conversation-1', false);
      expect(manager.closeTab).not.toHaveBeenCalled();
    });

    it('archives a batch after closing idle tabs and skips running sessions', async () => {
      const manager = createManager([
        { id: 'open-tab', conversationId: 'conversation-1' },
        { id: 'running-tab', conversationId: 'conversation-3', isWorking: true },
      ]);
      const { lifecycle, conversations } = createLifecycle(manager);

      await lifecycle.archive(['conversation-1', 'conversation-2', 'conversation-3']);

      expect(manager.closeTab).toHaveBeenCalledTimes(1);
      expect(manager.closeTab).toHaveBeenCalledWith('open-tab');
      expect(conversations.archiveConversationsIf).toHaveBeenCalledTimes(1);
      expect(conversations.archiveConversationsIf)
        .toHaveBeenCalledWith(['conversation-1', 'conversation-2'], expect.any(Function));
      expect(Notice).toHaveBeenCalledWith('Skipped 1 session that is open or running');
    });

    it('does not archive a session reopened while a later session in the batch is still closing', async () => {
      const manager = createManager([
        { id: 'tab-1', conversationId: 'conversation-1' },
        { id: 'tab-2', conversationId: 'conversation-2' },
      ]);
      let releaseSecondClose!: () => void;
      const close = manager.closeTab.getMockImplementation()!;
      manager.closeTab.mockImplementation(async (tabId: string) => {
        if (tabId === 'tab-2') await new Promise<void>((resolve) => { releaseSecondClose = resolve; });
        return close(tabId);
      });
      const { lifecycle, conversations } = createLifecycle(manager);

      const archiving = lifecycle.archive(['conversation-1', 'conversation-2']);
      await new Promise(resolve => setImmediate(resolve));
      manager.tabs.push({ id: 'reopened', conversationId: 'conversation-1', isWorking: true });
      releaseSecondClose();
      await archiving;

      await expect(conversations.archiveConversationsIf.mock.results[0].value).resolves.toBe(1);
      const shouldArchive = conversations.archiveConversationsIf.mock.calls[0][1];
      expect(shouldArchive({ id: 'conversation-1' } as never)).toBe(false);
      expect(shouldArchive({ id: 'conversation-2' } as never)).toBe(true);
      expect(Notice).toHaveBeenCalledWith('Skipped 1 session that is open or running');
    });
  });
});
