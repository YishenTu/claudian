import { createFixture, deferred, waitForCall } from '@test/helpers/ChatInputHarness';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ChatExecutionPreHandoffError, type ChatTurnSubmission } from '@/features/chat/execution/ChatExecutionCoordinator';

jest.mock('@/core/providers/ProviderRegistry', () => ({
  ProviderRegistry: {
    formatQuestionReply: jest.fn(),
    resolveTitleGenerationSelection: jest.fn().mockReturnValue(null),
    getCapabilities: jest.fn().mockReturnValue({
      providerId: 'claude',
      supportsFork: true,
      supportsNativeHistory: true,
      supportsTurnSteer: true,
    }),
  },
}));

describe('FirstTurnAdmission', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(ProviderRegistry.getCapabilities).mockReturnValue({
      providerId: 'claude',
      supportsFork: true,
      supportsNativeHistory: true,
      supportsTurnSteer: true,
    } as any);

  });

  it('skips title generation when no enabled title selection resolves', async () => {
    jest.mocked(ProviderRegistry.resolveTitleGenerationSelection).mockReturnValueOnce(null);
    const generateTitle = jest.fn().mockResolvedValue(undefined);
    const fixture = createFixture({ getTitleGenerationService: () => ({ generateTitle }) as any });
    fixture.plugin.settings.enableAutoTitleGeneration = true;
    fixture.plugin.settings.titleGenerationModel = 'removed-title-model';
    await fixture.controller.sendMessage({ content: 'keep this fallback' });
    expect(generateTitle).not.toHaveBeenCalled();
    expect(fixture.plugin.updateConversation).not.toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ titleGenerationStatus: 'pending' }),
    );
    expect(fixture.plugin.renameConversation).toHaveBeenCalled();
  });

  it('starts title generation independently of the execution session', async () => {
    jest.mocked(ProviderRegistry.resolveTitleGenerationSelection).mockReturnValueOnce({ providerId: 'claude', model: 'sonnet' });
    const generateTitle = jest.fn().mockResolvedValue(undefined);
    const fixture = createFixture({
      getTitleGenerationService: () => ({ generateTitle }) as any,
    });
    fixture.plugin.settings.enableAutoTitleGeneration = true;
    fixture.plugin.settings.titleGenerationModel = 'sonnet';

    await fixture.controller.sendMessage({ content: 'title this' });

    expect(generateTitle).toHaveBeenCalledWith(
      'conversation-1',
      'title this',
      expect.any(Function),
    );
    expect(fixture.coordinator.execute).toHaveBeenCalledTimes(1);
  });

  it('creates the first-turn conversation with its frozen Linked content', async () => {
    const token = Object.freeze({ path: 'Projects/Plan.md' });
    const linkedContentController = {
      beginSubmission: jest.fn().mockReturnValue(token),
      commitSubmission: jest.fn().mockReturnValue({
        linkedContentPath: 'Projects/Plan.md',
        queuedEvents: [],
      }),
      getSnapshot: jest.fn().mockReturnValue({
        mode: 'explicit-draft',
        path: 'Projects/Plan.md',
      }),
      rollbackSubmission: jest.fn(),
    };
    const fixture = createFixture({
      getLinkedContentController: () => linkedContentController,
    });
    fixture.state.currentConversationId = null;
    fixture.plugin.createConversation.mockResolvedValue({
      id: 'linked-conversation',
    });

    await fixture.controller.sendMessage({ content: 'Start linked session' });

    expect(fixture.plugin.createConversation).toHaveBeenCalledWith({
      providerId: 'claude',
      selectedModel: 'claude-model',
      linkedContentPath: 'Projects/Plan.md',
    });
    expect(linkedContentController.beginSubmission).toHaveBeenCalledTimes(1);
    expect(linkedContentController.commitSubmission).toHaveBeenCalledWith(token);
    expect(linkedContentController.rollbackSubmission).not.toHaveBeenCalled();
    expect(fixture.coordinator.execute).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({
        linkedContent: { path: 'Projects/Plan.md' },
      }),
    }), expect.any(AbortSignal));
  });

  it('restores the reconciled Linked content draft when Conversation creation fails', async () => {
    const token = Object.freeze({ path: 'Projects/Plan.md' });
    const linkedContentController = {
      beginSubmission: jest.fn().mockReturnValue(token),
      commitSubmission: jest.fn(),
      getSnapshot: jest.fn().mockReturnValue({
        mode: 'explicit-draft',
        path: 'Projects/Plan.md',
      }),
      rollbackSubmission: jest.fn(),
    };
    const fixture = createFixture({
      getLinkedContentController: () => linkedContentController,
    });
    fixture.state.currentConversationId = null;
    fixture.plugin.createConversation.mockRejectedValue(new Error('storage unavailable'));

    await expect(fixture.controller.sendMessage({ content: 'Start linked session' }))
      .rejects.toThrow('storage unavailable');

    expect(linkedContentController.rollbackSubmission).toHaveBeenCalledWith(token);
    expect(linkedContentController.commitSubmission).not.toHaveBeenCalled();
    expect(fixture.state.currentConversationId).toBeNull();
    expect(fixture.state.messages).toEqual([]);
    expect(fixture.input.value).toBe('Start linked session');
  });

  it('keeps a created zero-message Conversation locked and retries ordinal one', async () => {
    const token = Object.freeze({ path: 'Projects/Plan.md' });
    const linkedContentController = {
      beginSubmission: jest.fn().mockReturnValue(token),
      commitSubmission: jest.fn().mockReturnValue({
        linkedContentPath: 'Projects/Plan.md',
        queuedEvents: [],
      }),
      getSnapshot: jest.fn().mockReturnValue({
        mode: 'locked',
        path: 'Projects/Plan.md',
      }),
      rollbackSubmission: jest.fn(),
    };
    const fixture = createFixture({
      getLinkedContentController: () => linkedContentController,
    });
    fixture.state.currentConversationId = null;
    fixture.plugin.createConversation.mockResolvedValue({ id: 'linked-conversation' });
    fixture.coordinator.execute
      .mockRejectedValueOnce(new ChatExecutionPreHandoffError('not handed off'))
      .mockResolvedValueOnce({ accepted: true, status: 'completed' });

    await fixture.controller.sendMessage({ content: 'First attempt' });

    expect(fixture.state.currentConversationId).toBe('linked-conversation');
    expect(fixture.state.messages).toEqual([]);
    expect(linkedContentController.beginSubmission).toHaveBeenCalledTimes(1);
    expect(linkedContentController.commitSubmission).toHaveBeenCalledWith(token);
    expect(linkedContentController.rollbackSubmission).not.toHaveBeenCalled();

    await fixture.controller.sendMessage({ content: 'Retry first turn' });

    const submissions = fixture.coordinator.execute.mock.calls.map(
      call => call[0] as ChatTurnSubmission,
    );
    expect(submissions).toHaveLength(2);
    expect(submissions[0]).toMatchObject({
      context: { linkedContent: { path: 'Projects/Plan.md' } },
    });
    expect(submissions[1]).toMatchObject({
      context: { linkedContent: { path: 'Projects/Plan.md' } },
    });
    expect(fixture.plugin.createConversation).toHaveBeenCalledTimes(1);
  });

  it('rebinds Linked content when queued work is promoted to the first turn', async () => {
    const fixture = createFixture({
      getLinkedContentController: () => ({
        getSnapshot: () => ({ mode: 'locked', path: 'Projects/Plan.md' }),
      }),
    });
    fixture.state.messages = [
      { id: 'user-1', role: 'user', content: 'rolled back', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: '', timestamp: 2 },
    ];
    const releaseTurn = fixture.holdResponse();

    await fixture.controller.sendMessage({ content: 'Promoted queued turn' });

    expect(fixture.state.queuedMessage?.turnRequest?.linkedContentPath).toBeUndefined();

    const queuedMessage = fixture.state.queuedMessage!;
    fixture.controller.queue.clear();
    fixture.state.messages = [];
    await releaseTurn();
    await fixture.controller.sendMessage({
      content: queuedMessage.content,
      turnRequestOverride: queuedMessage.turnRequest,
    });

    expect(fixture.coordinator.execute).toHaveBeenCalledWith(expect.objectContaining({
      context: { linkedContent: { path: 'Projects/Plan.md' } },
      rawDisplayText: 'Promoted queued turn',
    }), expect.any(AbortSignal));
  });

  it('keeps the frozen first-send path when a queued rename settles during creation', async () => {
    let currentPath = 'Projects/Old';
    const token = Object.freeze({ path: currentPath });
    const linkedContentController = {
      beginSubmission: jest.fn().mockReturnValue(token),
      commitSubmission: jest.fn().mockImplementation(() => {
        currentPath = 'Projects/New';
        return {
          linkedContentPath: currentPath,
          queuedEvents: [{
            kind: 'rename',
            oldPath: 'Projects/Old',
            newPath: 'Projects/New',
            includeDescendants: true,
          }],
        };
      }),
      getSnapshot: jest.fn().mockImplementation(() => ({
        mode: currentPath === 'Projects/Old' ? 'explicit-draft' : 'locked',
        path: currentPath,
      })),
      rollbackSubmission: jest.fn(),
    };
    const fixture = createFixture({
      getLinkedContentController: () => linkedContentController,
    });
    fixture.state.currentConversationId = null;
    fixture.plugin.createConversation.mockResolvedValue({ id: 'linked-conversation' });

    await fixture.controller.sendMessage({ content: 'Use the frozen target' });

    expect(fixture.plugin.createConversation).toHaveBeenCalledWith(expect.objectContaining({
      linkedContentPath: 'Projects/Old',
    }));
    expect(fixture.coordinator.execute).toHaveBeenCalledWith(expect.objectContaining({
      context: { linkedContent: { path: 'Projects/Old' } },
    }), expect.any(AbortSignal));
    expect(linkedContentController.getSnapshot()).toMatchObject({
      mode: 'locked',
      path: 'Projects/New',
    });
  });

  it.each(['/compact', ' \t/CoMpAcT  '])('does not attach Linked content to compact command %j', async content => {
    const fixture = createFixture({
      getLinkedContentController: () => ({
        getSnapshot: () => ({ mode: 'locked', path: 'Projects/Plan.md' }),
      }),
    });

    await fixture.controller.sendMessage({ content });

    const submission = fixture.coordinator.execute.mock.calls[0][0] as ChatTurnSubmission;
    expect(submission.context).not.toHaveProperty('linkedContent');
  });
});

it('does not steer Linked content captured while the first turn resolves session references', async () => {
  const token = Object.freeze({ path: 'Projects/Plan.md' });
  const linkedContentController = {
    beginSubmission: jest.fn().mockReturnValue(token),
    commitSubmission: jest.fn().mockReturnValue({ linkedContentPath: 'Projects/Plan.md', queuedEvents: [] }),
    getSnapshot: jest.fn().mockReturnValue({ mode: 'explicit-draft', path: 'Projects/Plan.md' }),
    rollbackSubmission: jest.fn(),
  };
  const fixture = createFixture({ getLinkedContentController: () => linkedContentController });
  fixture.state.currentConversationId = null;
  fixture.plugin.createConversation.mockResolvedValue({ id: 'linked-conversation' });
  const source = deferred<unknown>();
  fixture.plugin.getConversationById.mockReturnValueOnce(source.promise);
  Object.assign(fixture.plugin, {
    findConversationAcrossViews: () => null,
    writeSessionSnapshot: jest.fn().mockResolvedValue('/tmp/claudian-sessions/source.md'),
  });
  const turn = deferred<{ accepted: boolean; status: string }>();
  fixture.coordinator.execute.mockReturnValueOnce(turn.promise);

  const first = fixture.controller.sendMessage({ content: 'Use @[Source](claudian-session:conv-1-source)' });
  await waitForCall(fixture.plugin.getConversationById);
  await fixture.controller.sendMessage({ content: 'steered follow-up' });
  source.resolve({
    id: 'conv-1-source', title: 'Source', providerId: 'claude', createdAt: 1, lastActivityAt: 2,
    messages: [{ id: 'u', role: 'user', content: 'source prompt', timestamp: 1 }],
  });
  await waitForCall(fixture.coordinator.execute);
  await fixture.controller.queue.steerNow();
  turn.resolve({ accepted: true, status: 'completed' });
  await first;

  expect(fixture.coordinator.execute.mock.calls[0][0]).toMatchObject({
    context: expect.objectContaining({ linkedContent: { path: 'Projects/Plan.md' } }),
  });
  expect(fixture.coordinator.steer).toHaveBeenCalledTimes(1);
  expect(fixture.coordinator.steer.mock.calls[0][0]).toMatchObject({ rawDisplayText: 'steered follow-up' });
  expect(fixture.coordinator.steer.mock.calls[0][0].context).not.toHaveProperty('linkedContent');
});
