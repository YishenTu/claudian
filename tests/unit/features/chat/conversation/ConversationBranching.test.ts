import { createConversationControllerDeps } from '@test/helpers/features/chat/ConversationControllerFixture';
import { testDate } from '@test/helpers/testClock';

import { ConversationController } from '@/features/chat/conversation/ConversationController';

jest.mock('@/shared/modals/ConfirmModal', () => ({
  confirm: jest.fn().mockResolvedValue(true),
}));

describe('ConversationBranching', () => {
  it.each([undefined, 'other-user'])('restores only the selected history and restores the edited prompt with images (target %s)', async target => {
    const retained = [{ id: 'shared', role: 'assistant' as const, content: 'Shared answer', timestamp: Date.now() }];
    const usage = { contextTokens: 12500, inputTokens: 12500, contextWindow: 200000, percentage: 6 };
    const navigateConversationBranch = jest.fn().mockResolvedValue({ status: 'committed', messages: retained, usage });
    const coordinator = { navigateConversationBranch };
    const deps = createConversationControllerDeps({
      getExecutionCoordinator: () => coordinator });
    deps.state.currentConversationId = 'conversation';
    const images = [{ id: 'image', name: 'image.png', data: 'abc', mimeType: 'image/png' }];
    deps.state.messages = [{ id: 'first', role: 'user', content: 'First', timestamp: 1 }, { id: 'user', role: 'user', content: 'raw', displayContent: 'Visible prompt', timestamp: Date.now(),
      images: images as any, userMessageId: 'native-user' }];
    const controller = new ConversationController(deps);
    await controller.navigateBranch('user', target);
    expect(navigateConversationBranch).toHaveBeenCalledTimes(target ? 1 : 0);
    expect(deps.plugin.updateConversation).toHaveBeenCalledTimes(target ? 1 : 0);
    expect(await controller.commitBranchDraft()).toMatchObject({ status: 'committed' });
    expect(navigateConversationBranch).toHaveBeenCalledWith(expect.objectContaining({ userMessageId: 'native-user', branchMessageId: target }));
    expect(deps.state.messages).toEqual(retained);
    expect(deps.state.usage).toEqual(usage);
    expect(deps.getInputEl().value).toBe(target ? '' : 'Visible prompt');
    expect(deps.plugin.updateConversation).toHaveBeenCalledWith('conversation', expect.objectContaining({ messages: retained, usage }));
    expect(deps.state.isRewinding).toBe(false);
  });

  it('preserves a draft and cancelled navigation without replacing history', async () => {
    const navigateConversationBranch = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const coordinator = { navigateConversationBranch };
    const deps = createConversationControllerDeps({ getExecutionCoordinator: () => coordinator });
    deps.state.currentConversationId = 'conversation';
    const messages = [{ id: 'first', role: 'user' as const, content: 'First', timestamp: 1 }, { id: 'user', role: 'user' as const, content: 'Original', timestamp: Date.now(),
      userMessageId: 'native-user', treeBranches: ['native-user'] }];
    deps.state.messages = messages;
    deps.getInputEl().value = 'Draft';
    const controller = new ConversationController(deps);
    await controller.navigateBranch('user');
    expect(navigateConversationBranch).not.toHaveBeenCalled();
    expect(deps.getInputEl().value).toBe('Draft');
    deps.getInputEl().value = '';
    await controller.navigateBranch('user');
    expect(await controller.commitBranchDraft()).toMatchObject({ status: 'cancelled' });
    expect(deps.state.messages).toEqual(messages);
    controller.cancelBranchDraft();
    expect(deps.getInputEl().value).toBe('');
    expect(deps.plugin.updateConversation).not.toHaveBeenCalled();
  });
});

it('reconciles a moved branch after save failure without replaying navigation or discarding the retry draft', async () => {
  const first = { id: 'first', role: 'user' as const, content: 'First', timestamp: testDate().getTime() };
  const prompt = { id: 'second', role: 'user' as const, content: 'Second', timestamp: testDate().getTime(), userMessageId: 'native-second' };
  const coordinator = {
    navigateConversationBranch: jest.fn().mockResolvedValue({ status: 'committed', messages: [first] }),
    reconcileConversationBranch: jest.fn().mockResolvedValue({ status: 'committed', messages: [first] }),
  };
  const deps = createConversationControllerDeps({ getExecutionCoordinator: () => coordinator });
  deps.state.currentConversationId = 'conversation';
  deps.state.messages = [first, prompt];
  jest.mocked(deps.plugin.updateConversation).mockRejectedValueOnce(new Error('Save unavailable'));
  const controller = new ConversationController(deps);
  await controller.navigateBranch('second');
  deps.getInputEl().value = 'Edited';
  expect(await controller.commitBranchDraft()).toMatchObject({ status: 'recovery-required' });
  controller.cancelBranchDraft();
  expect(deps.getInputEl().value).toBe('Edited');
  expect(deps.state.messages).toEqual([first]);
  expect(await controller.commitBranchDraft()).toMatchObject({ status: 'committed' });
  expect(coordinator.navigateConversationBranch).toHaveBeenCalledTimes(1);
  expect(coordinator.reconcileConversationBranch).toHaveBeenCalledTimes(1);
  expect(controller.hasBranchDraft).toBe(false);
});

it('keeps an unconfirmed branch edit retryable after reconciliation replaces message identities', async () => {
  const first = { id: 'first', role: 'user' as const, content: 'First', timestamp: testDate().getTime() };
  const prompt = { id: 'second', role: 'user' as const, content: 'Second', timestamp: testDate().getTime(), userMessageId: 'native-second' };
  const coordinator = {
    navigateConversationBranch: jest.fn().mockResolvedValueOnce({ status: 'recovery-required', error: 'Reply lost' })
      .mockResolvedValue({ status: 'committed', messages: [first] }),
    reconcileConversationBranch: jest.fn().mockResolvedValue({ status: 'cancelled', messages: [first, { ...prompt, id: 'reloaded' }] }),
  };
  const deps = createConversationControllerDeps({ getExecutionCoordinator: () => coordinator });
  deps.state.currentConversationId = 'conversation';
  deps.state.messages = [first, prompt];
  const controller = new ConversationController(deps);
  await controller.navigateBranch('second');
  expect(await controller.commitBranchDraft()).toMatchObject({ status: 'cancelled' });
  expect(controller.hasBranchDraft).toBe(true);
  expect(await controller.commitBranchDraft()).toMatchObject({ status: 'committed' });
  expect(coordinator.navigateConversationBranch).toHaveBeenCalledTimes(2);
  expect(coordinator.navigateConversationBranch).toHaveBeenLastCalledWith(expect.objectContaining({ userMessageId: 'native-second' }));
});

it.each(['conversation', 'coordinator'])('does not publish recovery after its %s owner changes', async owner => {
  const first = { id: 'first', role: 'user' as const, content: 'First', timestamp: testDate().getTime() };
  const prompt = { id: 'second', role: 'user' as const, content: 'Second', timestamp: testDate().getTime(), userMessageId: 'native-second' };
  const coordinator = {
    navigateConversationBranch: jest.fn().mockResolvedValue({ status: 'recovery-required', error: 'Reply lost' }),
    reconcileConversationBranch: jest.fn(),
  };
  const deps = createConversationControllerDeps({ getExecutionCoordinator: () => coordinator });
  deps.state.currentConversationId = 'conversation';
  deps.state.messages = [first, prompt];
  coordinator.reconcileConversationBranch.mockImplementation(async () => {
    if (owner === 'conversation') deps.state.currentConversationId = 'replacement';
    else deps.getExecutionCoordinator = () => null;
    return { status: 'committed', messages: [first] };
  });
  const controller = new ConversationController(deps);
  await controller.navigateBranch('second');
  expect(await controller.commitBranchDraft()).toMatchObject({ status: 'failed' });
  expect(deps.state.messages).toEqual([first, prompt]);
  expect(deps.plugin.updateConversation).not.toHaveBeenCalled();
});
