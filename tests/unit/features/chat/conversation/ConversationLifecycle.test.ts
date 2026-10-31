import { projectRecord } from '@test/helpers/features/chat/ProjectsFake';
import { Notice } from 'obsidian';
import type { Mock, Mocked } from 'vitest';

import type { ProjectRecord } from '@/core/types';
import { ConversationLifecycle, type ConversationLifecycleStore } from '@/features/chat/conversation/ConversationLifecycle';

interface FakeTab {
  id: string;
  conversationId: string | null;
  isWorking?: boolean;
}

function createManager(initialTabs: FakeTab[]) {
  const manager = {
    tabs: initialTabs,
    closeTab: vi.fn(async (tabId: string) => {
      manager.tabs = manager.tabs.filter(tab => tab.id !== tabId);
      return true;
    }),
    getTabIdentities: () => manager.tabs,
    isTabWorking: (tabId: string) => manager.tabs.find(tab => tab.id === tabId)?.isWorking ?? false,
    resetConversationTabs: vi.fn().mockResolvedValue(undefined),
  };
  return manager;
}

type FakeManager = ReturnType<typeof createManager>;

function createStore(): Mocked<ConversationLifecycleStore> {
  return {
    getConversationList: vi.fn(() => []),
    deleteConversation: vi.fn().mockResolvedValue(undefined),
    setConversationArchived: vi.fn().mockResolvedValue(undefined),
    setConversationsPlacement: vi.fn().mockResolvedValue(undefined),
    restoreConversations: vi.fn().mockResolvedValue(undefined),
    ensureAllConversationMetadataLoaded: vi.fn().mockResolvedValue(undefined),
    archiveProjectIfEmpty: vi.fn().mockResolvedValue(undefined),
    archiveConversationsIf: vi.fn(async (ids, shouldArchive) => (
      ids.filter(id => shouldArchive({ id } as never)).length
    )),
  };
}

function createProjects(records: ProjectRecord[] = []) {
  const live = new Map(records.map(record => [record.id, record]));
  return {
    get: vi.fn((id: string | undefined) => (id === undefined ? null : live.get(id) ?? null)),
    setArchived: vi.fn(async (id: string, isArchived: boolean) => {
      const record = live.get(id);
      if (record) live.set(id, { ...record, isArchived });
    }),
  };
}

function createLifecycle(...managers: Array<FakeManager | null>) {
  return createLifecycleWith(createProjects(), ...managers);
}

function createLifecycleWith(projects: ReturnType<typeof createProjects>, ...managers: Array<FakeManager | null>) {
  const conversations = createStore();
  const views = managers.map(manager => ({ getTabManager: () => manager }));
  const lifecycle = new ConversationLifecycle({
    conversations,
    projects,
    sessions: { get: () => null, isRunning: id => managers.some(manager => manager?.tabs.some(tab => tab.conversationId === id && tab.isWorking)), retire: async () => undefined, whenSettled: async () => true },
    views: { getAllViews: () => views as never },
  });
  return { lifecycle, conversations, projects };
}

describe('ConversationLifecycle', () => {
  beforeEach(() => {
    (Notice as unknown as Mock).mockClear();
  });

  describe('project archive', () => {
    function setupProject(running: string[] = [], launchArchived = false) {
      const manager = createManager([
        ...running.map(id => ({ id: `tab-${id}`, conversationId: id, isWorking: true })),
        { id: 'tab-idle', conversationId: 'idle' },
      ]);
      const projects = createProjects([
        projectRecord({ id: 'launch', isArchived: launchArchived }),
        projectRecord({ id: 'other' }),
      ]);
      const { lifecycle, conversations } = createLifecycleWith(projects, manager);
      const list = [
        { id: 'idle', isArchived: false, projectId: 'launch' },
        { id: 'busy', isArchived: false, projectId: 'launch' },
        { id: 'done', isArchived: true, projectId: 'launch' },
        { id: 'outside', isArchived: false, projectId: 'other' },
      ];
      conversations.getConversationList.mockReturnValue(list);
      return { lifecycle, conversations, manager, projects };
    }

    it('archives every active member, closing idle tabs, then the project', async () => {
      const { lifecycle, conversations, manager } = setupProject();

      await lifecycle.archiveProject('launch');

      expect(manager.closeTab).toHaveBeenCalledWith('tab-idle');
      expect(conversations.archiveConversationsIf.mock.calls[0]![0]).toEqual(['idle', 'busy']);
      expect(conversations.archiveProjectIfEmpty).toHaveBeenCalledWith('launch');
      expect(conversations.archiveConversationsIf.mock.invocationCallOrder[0])
        .toBeLessThan(conversations.archiveProjectIfEmpty.mock.invocationCallOrder[0]!);
    });

    it('keeps the project active when a member is running', async () => {
      const { lifecycle, conversations } = setupProject(['busy']);

      await lifecycle.archiveProject('launch');

      expect(conversations.archiveProjectIfEmpty).not.toHaveBeenCalled();
      expect(Notice).toHaveBeenCalledWith('Skipped 1 session that is open or running');
    });

    it('restores the project before its archived members', async () => {
      const { lifecycle, conversations, projects } = setupProject([], true);

      await lifecycle.restoreProject('launch');

      expect(projects.setArchived).toHaveBeenCalledWith('launch', false);
      expect(conversations.restoreConversations).toHaveBeenCalledWith(['done']);
      expect(projects.setArchived.mock.invocationCallOrder[0])
        .toBeLessThan(conversations.restoreConversations.mock.invocationCallOrder[0]!);
    });
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
    it('pins in one batch without touching tabs in any view', async () => {
      const local = createManager([{ id: 'pinned-tab', conversationId: 'conversation-1' }]);
      const { lifecycle, conversations } = createLifecycle(local);

      await lifecycle.setPinned(['conversation-1', 'conversation-2'], true);

      expect(conversations.setConversationsPlacement).toHaveBeenCalledTimes(1);
      expect(conversations.setConversationsPlacement)
        .toHaveBeenCalledWith(['conversation-1', 'conversation-2'], { isPinned: true });
      expect(local.resetConversationTabs).not.toHaveBeenCalled();
      expect(local.closeTab).not.toHaveBeenCalled();
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
      expect(conversations.archiveConversationsIf).toHaveBeenCalledWith(['conversation-1'], expect.any(Function));
      expect(other.closeTab.mock.invocationCallOrder[0])
        .toBeLessThan(conversations.archiveConversationsIf.mock.invocationCallOrder[0]);
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


describe('committed archive mailbox cleanup', () => {
  it('preserves pending messages when an archive write fails without committing', async () => {
    const conversations = createStore();
    const clear = vi.fn();
    conversations.getConversationList.mockReturnValue([{ id: 'target', isArchived: false }]);
    conversations.archiveConversationsIf.mockRejectedValue(new Error('write failed'));
    const lifecycle = new ConversationLifecycle({
      conversations,
      projects: createProjects(),
      sessions: { get: () => ({ mailbox: { clear } }) as never, isRunning: () => false, retire: async () => undefined, whenSettled: async () => true },
      views: { getAllViews: () => [] },
    });
    await expect(lifecycle.archiveIf(['target'], () => true)).rejects.toThrow('write failed');
    expect(clear).not.toHaveBeenCalled();
  });

  it.each(['manual', 'batch', 'automatic'] as const)('clears only committed archives after %s persistence settles', async mode => {
    const conversations = createStore();
    const clear = vi.fn();
    let archived = false;
    let release!: () => void;
    conversations.getConversationList.mockImplementation(() => [{ id: 'target', isArchived: archived }]);
    conversations.archiveConversationsIf.mockImplementation(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      archived = true;
      return 1;
    });
    const lifecycle = new ConversationLifecycle({
      conversations,
      projects: createProjects(),
      sessions: { get: () => ({ mailbox: { clear } }) as never, isRunning: () => false, retire: async () => undefined, whenSettled: async () => true },
      views: { getAllViews: () => [] },
    });
    const saving = mode === 'manual' ? lifecycle.setArchived('target', true)
      : mode === 'batch' ? lifecycle.archive(['target']) : lifecycle.archiveIf(['target'], () => true);
    await new Promise(resolve => setImmediate(resolve));
    expect(clear).not.toHaveBeenCalled();
    release();
    await saving;
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
