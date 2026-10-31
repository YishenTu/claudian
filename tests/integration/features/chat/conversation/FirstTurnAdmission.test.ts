import '@/providers';

// @vitest-environment jsdom
import { createFixture, deferred, waitForCall } from '@test/helpers/ChatInputHarness';
import { conversationRecord } from '@test/helpers/features/chat/ConversationFixture';
import { createProjectsFake } from '@test/helpers/features/chat/ProjectsFake';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { Conversation } from '@/core/types';

const nativeCapabilities = ProviderRegistry.getCapabilities('claude');
beforeEach(() => {
  vi.spyOn(ProviderRegistry, 'resolveTitleGenerationSelection');
  vi.spyOn(ProviderRegistry, 'getCapabilities').mockReturnValue({ ...nativeCapabilities, supportsTurnSteer: true });
});
afterEach(() => vi.restoreAllMocks());


describe('FirstTurnAdmission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ProviderRegistry.getCapabilities).mockReturnValue({
      ...nativeCapabilities,
      providerId: 'claude',
      supportsFork: true,
      supportsNativeHistory: true,
      supportsTurnSteer: true,
    });

  });

  it('skips title generation when no enabled title selection resolves', async () => {
    vi.mocked(ProviderRegistry.resolveTitleGenerationSelection).mockReturnValueOnce(null);
    const generateTitle = vi.fn().mockResolvedValue(undefined);
    const fixture = (await createFixture({ getTitleGenerationService: () => ({ generateTitle, cancel: vi.fn() }) }));
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
    vi.mocked(ProviderRegistry.resolveTitleGenerationSelection).mockReturnValueOnce({ providerId: 'claude', model: 'sonnet' });
    const generateTitle = vi.fn().mockResolvedValue(undefined);
    const fixture = (await createFixture({
      getTitleGenerationService: () => ({ generateTitle, cancel: vi.fn() }),
    }));
    fixture.plugin.settings.enableAutoTitleGeneration = true;
    fixture.plugin.settings.titleGenerationModel = 'sonnet';

    await fixture.controller.sendMessage({ content: 'title this' });

    expect(generateTitle).toHaveBeenCalledWith(
      'conversation-1',
      'title this',
      expect.any(Function),
    );
    expect(fixture.native.requests).toHaveLength(1);
  });

  it('creates the first-turn conversation with its frozen Linked content', async () => {
    const fixture = await createFixture();
    const linkedContentController = fixture.linkedContentController;
    linkedContentController.selectExplicit('Projects/Plan.md');
    fixture.state.currentConversationId = null;
    fixture.plugin.createConversation.mockResolvedValue(conversationRecord('linked-conversation'));

    await fixture.controller.sendMessage({ content: 'Start linked session' });

    expect(fixture.plugin.createConversation).toHaveBeenCalledWith({
      providerId: 'claude',
      selectedModel: 'claude-model',
      linkedContentPath: 'Projects/Plan.md',
    });
    expect(linkedContentController.getSnapshot()).toEqual({ mode: 'locked', path: 'Projects/Plan.md' });
    expect(fixture.native.requests[0]).toMatchObject({
      context: expect.objectContaining({
        linkedContent: { path: 'Projects/Plan.md' },
      }),
    });
  });

  it('restores the reconciled Linked content draft when Conversation creation fails', async () => {
    const fixture = await createFixture();
    const linkedContentController = fixture.linkedContentController;
    linkedContentController.selectExplicit('Projects/Plan.md');
    fixture.state.currentConversationId = null;
    fixture.plugin.createConversation.mockRejectedValue(new Error('storage unavailable'));

    await expect(fixture.controller.sendMessage({ content: 'Start linked session' }))
      .rejects.toThrow('storage unavailable');

    expect(linkedContentController.getSnapshot()).toEqual({ mode: 'explicit-draft', path: 'Projects/Plan.md' });
    expect(fixture.state.currentConversationId).toBeNull();
    expect(fixture.state.messages).toEqual([]);
    expect(fixture.input.value).toBe('Start linked session');
  });

  it('creates a project-seeded draft with its raw frozen seed, keeping the seed across failed creation', async () => {
    const fixture = (await createFixture());
    // No live record: whether the seed still names a project is the repository's decision at creation, not admission's.
    Object.assign(fixture.plugin, { projects: createProjectsFake([]) });
    fixture.state.currentConversationId = null;
    fixture.deps.conversationController.seedDraftProject('project-1');
    fixture.plugin.createConversation
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockResolvedValue(conversationRecord('project-conversation'));

    await expect(fixture.controller.sendMessage({ content: 'First attempt' })).rejects.toThrow('storage unavailable');
    await fixture.controller.sendMessage({ content: 'Retry' });

    const expected = { providerId: 'claude', selectedModel: 'claude-model', projectId: 'project-1' };
    expect(fixture.plugin.createConversation.mock.calls).toEqual([[expected], [expected]]);
    expect(fixture.state.currentConversationId).toBe('project-conversation');
  });

  it('keeps a created zero-message Conversation locked and retries ordinal one', async () => {
    const fixture = await createFixture();
    const linkedContentController = fixture.linkedContentController;
    linkedContentController.selectExplicit('Projects/Plan.md');
    fixture.state.currentConversationId = null;
    fixture.plugin.createConversation.mockResolvedValue(conversationRecord('linked-conversation'));
    fixture.execution.repository.assertConversationExecutionAuthority.mockRejectedValueOnce(new Error('not handed off'));

    await fixture.controller.sendMessage({ content: 'First attempt' });

    expect(fixture.state.currentConversationId).toBe('linked-conversation');
    expect(fixture.state.messages).toEqual([]);
    expect(linkedContentController.getSnapshot()).toEqual({ mode: 'locked', path: 'Projects/Plan.md' });

    expect(fixture.native.requests).toHaveLength(0);
    await fixture.controller.sendMessage({ content: 'Retry first turn' });

    expect(fixture.native.requests).toMatchObject([{
      input: [{ type: 'text', text: 'Retry first turn' }],
      context: { linkedContent: { path: 'Projects/Plan.md' } },
      conversationHistory: [],
    }]);
    expect(fixture.plugin.createConversation).toHaveBeenCalledTimes(1);
  });

  it('rebinds Linked content when queued work is promoted to the first turn', async () => {
    const fixture = await createFixture();
    fixture.linkedContentController.lock('Projects/Plan.md');
    fixture.state.messages = [
      { id: 'user-1', role: 'user', content: 'rolled back', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: '', timestamp: 2 },
    ];
    const releaseTurn = await fixture.holdResponse();

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

    expect(fixture.native.requests[0]).toMatchObject({
      context: { linkedContent: { path: 'Projects/Plan.md' } },
      input: [{ type: 'text', text: 'Promoted queued turn' }],
    });
  });

  it('keeps the frozen first-send path when a queued rename settles during creation', async () => {
    const fixture = await createFixture();
    const linkedContentController = fixture.linkedContentController;
    linkedContentController.selectExplicit('Projects/Old');
    fixture.state.currentConversationId = null;
    fixture.plugin.createConversation.mockImplementationOnce(async () => {
      linkedContentController.handleRenamed('Projects/Old', 'Projects/New');
      return conversationRecord('linked-conversation');
    });

    await fixture.controller.sendMessage({ content: 'Use the frozen target' });

    expect(fixture.plugin.createConversation).toHaveBeenCalledWith(expect.objectContaining({
      linkedContentPath: 'Projects/Old',
    }));
    expect(fixture.native.requests[0]).toMatchObject({
      context: { linkedContent: { path: 'Projects/Old' } },
    });
    expect(linkedContentController.getSnapshot()).toMatchObject({
      mode: 'locked',
      path: 'Projects/New',
    });
  });

  it.each(['/compact', ' \t/CoMpAcT  '])('does not attach Linked content to compact command %j', async content => {
    const fixture = await createFixture();
    fixture.linkedContentController.lock('Projects/Plan.md');

    await fixture.controller.sendMessage({ content });

    const submission = fixture.native.requests[0];
    expect(submission.context).not.toHaveProperty('linkedContent');
  });
});

it('does not steer Linked content captured while the first turn resolves session references', async () => {
  const fixture = await createFixture();
  fixture.linkedContentController.selectExplicit('Projects/Plan.md');
  fixture.state.currentConversationId = null;
  fixture.plugin.createConversation.mockResolvedValue(conversationRecord('linked-conversation'));
  const source = deferred<Conversation | null>();
  fixture.plugin.getConversationById.mockReturnValueOnce(source.promise);
  Object.assign(fixture.plugin, {
    findConversationAcrossViews: () => null,
  });
  const turn = fixture.holdNextResponse();

  const first = fixture.controller.sendMessage({ content: 'Use @[Source](claudian-session:conv-1-source)' });
  await waitForCall(fixture.plugin.getConversationById);
  await fixture.controller.sendMessage({ content: 'steered follow-up' });
  source.resolve({
    id: 'conv-1-source', title: 'Source', providerId: 'claude', sessionId: null, createdAt: 1, lastActivityAt: 2,
    messages: [{ id: 'u', role: 'user', content: 'source prompt', timestamp: 1 }],
  });
  await turn.started;
  await fixture.controller.queue.steerNow();
  (await turn.started).complete();
  await first;

  expect(fixture.native.requests[0]).toMatchObject({
    context: expect.objectContaining({ linkedContent: { path: 'Projects/Plan.md' } }),
  });
  expect(fixture.native.steerRequests).toHaveLength(1);
  expect(fixture.native.steerRequests[0].input).toEqual([{ type: 'text', text: 'steered follow-up' }]);
  expect(fixture.native.steerRequests[0].context).not.toHaveProperty('linkedContent');
});
