import { holdResponse } from '@test/helpers/ConversationPorts';
import { createConversationControllerDeps } from '@test/helpers/features/chat/ConversationControllerFixture';
import { Notice } from 'obsidian';

import { ConversationController } from '@/features/chat/conversation/ConversationController';
import { confirm } from '@/shared/modals/ConfirmModal';

jest.mock('@/shared/modals/ConfirmModal', () => ({
  confirm: jest.fn().mockResolvedValue(true),
}));

const mockNotice = Notice as jest.Mock;

describe('ConversationRewind', () => {
  let controller: ConversationController;
  let deps: ReturnType<typeof createConversationControllerDeps>;
  let mockCoordinator: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCoordinator = {
      previewRewind: jest.fn().mockResolvedValue({ canRewind: true }),
      rewind: jest.fn().mockResolvedValue({ canRewind: true, filesChanged: ['a.ts'] }),
    };
    deps = createConversationControllerDeps({
      getExecutionCoordinator: () => mockCoordinator,
    });
    controller = new ConversationController(deps);
  });

  it('should find prev/response assistants with bounded scan (skipping non-uuid messages)', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'prev-a' },
      { id: 'm2', role: 'assistant', content: 'boundary', timestamp: 2 }, // No uuid
      { id: 'm3', role: 'user', content: 'test', timestamp: 3, userMessageId: 'user-uuid' },
      { id: 'm4', role: 'assistant', content: 'boundary2', timestamp: 4 }, // No uuid
      { id: 'm5', role: 'assistant', content: 'resp', timestamp: 5, assistantMessageId: 'resp-a' },
    ];

    await controller.rewind('m3');

    expect(mockCoordinator.rewind).toHaveBeenCalledWith('user-uuid', 'prev-a', 'code-and-conversation');
  });

  it('should initialize a cold conversation execution before previewing rewind', async () => {
    let coordinator: typeof mockCoordinator | null = null;
    const ensureExecutionInitialized = jest.fn().mockImplementation(async () => {
      coordinator = mockCoordinator;
      return true;
    });
    deps = createConversationControllerDeps({
      getExecutionCoordinator: () => coordinator,
      ensureExecutionInitialized,
    });
    controller = new ConversationController(deps);
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'prev-a' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'user-uuid' },
      { id: 'm3', role: 'assistant', content: 'resp', timestamp: 3, assistantMessageId: 'resp-a' },
    ];

    await controller.rewind('m2');

    expect(ensureExecutionInitialized).toHaveBeenCalledTimes(1);
    expect(mockCoordinator.previewRewind).toHaveBeenCalledWith(
      'user-uuid',
      'prev-a',
      'code-and-conversation',
    );
    expect(mockCoordinator.rewind).toHaveBeenCalled();
  });

  it('should reject a second rewind while the first preview is pending', async () => {
    const previewResolvers: Array<(value: { canRewind: true }) => void> = [];
    mockCoordinator.previewRewind = jest.fn().mockImplementation(() => (
      new Promise(resolve => { previewResolvers.push(resolve); })
    ));
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'prev-a' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'user-uuid' },
      { id: 'm3', role: 'assistant', content: 'resp', timestamp: 3, assistantMessageId: 'resp-a' },
    ];

    const firstRewind = controller.rewind('m2');
    await Promise.resolve();
    const secondRewind = controller.rewind('m2');
    await Promise.resolve();
    const previewCallCountBeforeResolution = mockCoordinator.previewRewind.mock.calls.length;
    previewResolvers.forEach(resolve => resolve({ canRewind: true }));
    await Promise.all([firstRewind, secondRewind]);

    expect(previewCallCountBeforeResolution).toBe(1);
    expect(mockCoordinator.rewind).toHaveBeenCalledTimes(1);
    expect(mockNotice).toHaveBeenCalledWith(expect.stringContaining('rewind to finish'));
  });

  it('should show Notice when message ID not found', async () => {
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'a1' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'u1' },
      { id: 'm3', role: 'assistant', content: '', timestamp: 3, assistantMessageId: 'a2' },
    ];

    await controller.rewind('nonexistent');

    expect(mockNotice).toHaveBeenCalled();
    expect(mockCoordinator.rewind).not.toHaveBeenCalled();
  });

  it('should show Notice when streaming', async () => {
    holdResponse(deps.session.turns);
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'a1' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'u1' },
      { id: 'm3', role: 'assistant', content: '', timestamp: 3, assistantMessageId: 'a2' },
    ];

    await controller.rewind('m2');

    expect(mockNotice).toHaveBeenCalled();
    expect(mockCoordinator.rewind).not.toHaveBeenCalled();
  });

  it('should show Notice when user message has no userMessageId', async () => {
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'a1' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2 }, // No userMessageId
      { id: 'm3', role: 'assistant', content: '', timestamp: 3, assistantMessageId: 'a2' },
    ];

    await controller.rewind('m2');

    expect(mockNotice).toHaveBeenCalled();
    expect(mockCoordinator.rewind).not.toHaveBeenCalled();
  });

  it('should allow rewind when no previous assistant with uuid exists', async () => {
    deps.state.messages = [
      { id: 'm1', role: 'user', content: 'test', timestamp: 1, userMessageId: 'u1' },
      { id: 'm2', role: 'assistant', content: '', timestamp: 2, assistantMessageId: 'a1' },
    ];

    await controller.rewind('m1');

    expect(mockCoordinator.rewind).toHaveBeenCalledWith('u1', undefined, 'code-and-conversation');
  });

  it('should show Notice when no response assistant with uuid exists', async () => {
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'a1' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'u1' },
    ];

    await controller.rewind('m2');

    expect(mockNotice).toHaveBeenCalled();
    expect(mockCoordinator.rewind).not.toHaveBeenCalled();
  });

  it('should show i18n Notice on coordinator rewind exception', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'a1' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'u1' },
      { id: 'm3', role: 'assistant', content: '', timestamp: 3, assistantMessageId: 'a2' },
    ];
    mockCoordinator.rewind.mockRejectedValue(new Error('Coordinator error'));

    await controller.rewind('m2');

    expect(mockNotice).toHaveBeenCalled();
    const msg = mockNotice.mock.calls[0][0] as string;
    expect(msg).toContain('Coordinator error');
    expect(deps.state.isRewinding).toBe(false);
  });

  it('should show i18n Notice when canRewind is false', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'a1' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'u1' },
      { id: 'm3', role: 'assistant', content: '', timestamp: 3, assistantMessageId: 'a2' },
    ];
    mockCoordinator.rewind.mockResolvedValue({ canRewind: false, error: 'No checkpoints' });

    await controller.rewind('m2');

    expect(mockNotice).toHaveBeenCalled();
    const msg = mockNotice.mock.calls[0][0] as string;
    expect(msg).toContain('No checkpoints');
  });

  it('should truncateAt, save with resumeAtMessageId, and renderMessages on success', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.usage = { inputTokens: 100, outputTokens: 50 } as any;
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'prev-a' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'user-uuid' },
      { id: 'm3', role: 'assistant', content: 'resp', timestamp: 3, assistantMessageId: 'resp-a' },
    ];

    const truncateSpy = jest.spyOn(deps.state, 'truncateAt');

    await controller.rewind('m2');

    expect(confirm).toHaveBeenCalledWith(
      deps.plugin.app,
      expect.stringContaining('cannot be undone'),
      'Rewind',
    );
    expect((confirm as jest.Mock).mock.calls[0][1]).not.toContain('does not affect');
    expect(mockCoordinator.rewind).toHaveBeenCalledWith('user-uuid', 'prev-a', 'code-and-conversation');
    expect(truncateSpy).toHaveBeenCalledWith('m2');
    expect(deps.state.usage).toBeNull();
    expect(deps.renderer.renderMessages).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Function)
    );
    expect(deps.plugin.updateConversation).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({ resumeAtMessageId: 'prev-a' })
    );

    // Should populate input with rewound message content
    const inputEl = deps.getInputEl();
    expect(inputEl.value).toBe('test');
    expect(inputEl.focus).toHaveBeenCalled();

    // Should show success notice with file count
    const noticeMsg = mockNotice.mock.calls[0][0] as string;
    expect(noticeMsg).toContain('1');

    truncateSpy.mockRestore();
  });

  it('should restore the rewound message through the composer owner', async () => {
    deps = createConversationControllerDeps({
      getExecutionCoordinator: () => mockCoordinator,
    });
    controller = new ConversationController(deps);
    const images = [{ id: 'image-1', name: 'reference.png' }];
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'prev-a' },
      {
        content: '',
        displayContent: 'restore this prompt',
        id: 'm2',
        images: images as any,
        role: 'user',
        timestamp: 2,
        userMessageId: 'user-uuid',
      },
      { id: 'm3', role: 'assistant', content: 'resp', timestamp: 3, assistantMessageId: 'resp-a' },
    ];

    await controller.rewind('m2');

    expect(deps.getInputEl().value).toBe('restore this prompt');
    expect(deps.getInputEl().focus).toHaveBeenCalled();
  });

  it('should rewind to before the first user message and clear provider session state', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'user', content: 'first prompt', timestamp: 1, userMessageId: 'user-uuid' },
      { id: 'm2', role: 'assistant', content: 'resp', timestamp: 2, assistantMessageId: 'resp-a' },
    ];

    await controller.rewind('m1');

    expect(mockCoordinator.rewind).toHaveBeenCalledWith('user-uuid', undefined, 'code-and-conversation');
    expect(deps.state.messages).toEqual([]);
    expect(deps.plugin.updateConversation).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        messages: [],
        sessionId: null,
        providerState: undefined,
        resumeAtMessageId: undefined,
      })
    );
    expect(deps.getInputEl().value).toBe('first prompt');
  });

  it('should pass conversation-only mode and keep file changes', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'prev-a' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'user-uuid' },
      { id: 'm3', role: 'assistant', content: 'resp', timestamp: 3, assistantMessageId: 'resp-a' },
    ];

    await controller.rewind('m2', 'conversation');

    expect(confirm).toHaveBeenCalledWith(
      deps.plugin.app,
      'Rewind conversation to this point? File changes will be kept.',
      'Rewind',
    );
    expect(mockCoordinator.rewind).toHaveBeenCalledWith('user-uuid', 'prev-a', 'conversation');
    expect(deps.plugin.updateConversation).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({ resumeAtMessageId: 'prev-a' })
    );
    const noticeMsg = mockNotice.mock.calls[0][0] as string;
    expect(noticeMsg).toBe('Rewound conversation; file changes kept');
  });

  it('should preview file rewind and surface provider conflicts before confirmation', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'prev-a' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'user-uuid' },
      { id: 'm3', role: 'assistant', content: 'resp', timestamp: 3, assistantMessageId: 'resp-a' },
    ];
    mockCoordinator.previewRewind = jest.fn().mockResolvedValue({
      canRewind: true,
      conflicts: [{ conflictType: 'modified_externally', path: 'notes/conflicted.md' }],
      filesChanged: ['notes/conflicted.md'],
    });

    await controller.rewind('m2');

    expect(mockCoordinator.previewRewind).toHaveBeenCalledWith(
      'user-uuid',
      'prev-a',
      'code-and-conversation',
    );
    expect(confirm).toHaveBeenCalledWith(
      deps.plugin.app,
      expect.stringContaining('notes/conflicted.md'),
      'Rewind',
    );
    expect((confirm as jest.Mock).mock.calls[0][1]).toContain('overwritten');
    expect(mockCoordinator.rewind).toHaveBeenCalled();
  });

  it('should abort when provider rewind preview rejects the checkpoint', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'prev-a' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'user-uuid' },
      { id: 'm3', role: 'assistant', content: 'resp', timestamp: 3, assistantMessageId: 'resp-a' },
    ];
    mockCoordinator.previewRewind = jest.fn().mockResolvedValue({
      canRewind: false,
      error: 'Checkpoint is no longer available',
    });

    await controller.rewind('m2');

    expect(confirm).not.toHaveBeenCalled();
    expect(mockCoordinator.rewind).not.toHaveBeenCalled();
    expect(mockNotice).toHaveBeenCalledWith(expect.stringContaining('Checkpoint is no longer available'));
  });

  it('should leave provider-native session persistence to the coordinator', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'user', content: 'first prompt', timestamp: 1, userMessageId: 'user-uuid' },
      { id: 'm2', role: 'assistant', content: 'resp', timestamp: 2, assistantMessageId: 'resp-a' },
    ];
    mockCoordinator.rewind.mockResolvedValue({
      canRewind: true,
      filesChanged: [],
      sessionStrategy: 'preserve-provider-session',
    });

    await controller.rewind('m1');

    const updates = (deps.plugin.updateConversation as jest.Mock).mock.calls[0][1];
    expect(updates).toEqual(expect.objectContaining({
      messages: [],
      resumeAtMessageId: undefined,
    }));
    expect(updates).not.toHaveProperty('sessionId');
    expect(updates).not.toHaveProperty('providerState');
  });

  it('should abort when confirmation is declined', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'a1' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'u1' },
      { id: 'm3', role: 'assistant', content: '', timestamp: 3, assistantMessageId: 'a2' },
    ];
    (confirm as jest.Mock).mockResolvedValueOnce(false);

    await controller.rewind('m2');

    expect(mockCoordinator.rewind).not.toHaveBeenCalled();
    expect(mockNotice).not.toHaveBeenCalled();
  });

  it('should re-check streaming state after confirmation dialog', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'a1' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'u1' },
      { id: 'm3', role: 'assistant', content: '', timestamp: 3, assistantMessageId: 'a2' },
    ];
    (confirm as jest.Mock).mockImplementationOnce(async () => {
      // Rewind closes turn admission, so only an outside owner change can make the tab busy here.
      jest.spyOn(deps.session, 'hasActiveTurn', 'get').mockReturnValue(true);
      return true;
    });

    await controller.rewind('m2');

    expect(mockCoordinator.rewind).not.toHaveBeenCalled();
    expect(mockNotice).toHaveBeenCalled();
  });

  it('should show a warning notice when rewind succeeded but save failed', async () => {
    deps.state.currentConversationId = 'conv-1';
    deps.state.messages = [
      { id: 'm1', role: 'assistant', content: '', timestamp: 1, assistantMessageId: 'prev-a' },
      { id: 'm2', role: 'user', content: 'test', timestamp: 2, userMessageId: 'user-uuid' },
      { id: 'm3', role: 'assistant', content: 'resp', timestamp: 3, assistantMessageId: 'resp-a' },
    ];

    (deps.plugin.updateConversation as jest.Mock).mockRejectedValueOnce(new Error('Save failed'));

    await controller.rewind('m2');

    expect(mockCoordinator.rewind).toHaveBeenCalledWith('user-uuid', 'prev-a', 'code-and-conversation');
    const msg = mockNotice.mock.calls[0][0] as string;
    expect(msg).toContain('Save failed');
  });
});
