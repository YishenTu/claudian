import { createConversationControllerDeps } from '@test/helpers/features/chat/ConversationControllerFixture';
import { createProjectsFake, projectRecord } from '@test/helpers/features/chat/ProjectsFake';
import { testDate } from '@test/helpers/testClock';

import { buildSystemPrompt } from '@/core/prompt/mainAgent';
import { renderProjectMemberInstructions } from '@/core/prompt/projectPrompt';
import { ConversationController } from '@/features/chat/conversation/ConversationController';

vi.mock('@/shared/modals/ConfirmModal', () => ({
  confirm: vi.fn().mockResolvedValue(true),
}));

describe('ConversationBranching', () => {
  it.each([undefined, 'other-user'])('restores only the selected history and restores the edited prompt with images (target %s)', async target => {
    const retained = [{ id: 'shared', role: 'assistant' as const, content: 'Shared answer', timestamp: Date.now() }];
    const usage = { contextTokens: 12500, inputTokens: 12500, contextWindow: 200000, percentage: 6 };
    const navigateConversationBranch = vi.fn().mockResolvedValue({ status: 'committed', messages: retained, usage });
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
    const navigateConversationBranch = vi.fn().mockResolvedValue({ status: 'cancelled' });
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
    navigateConversationBranch: vi.fn().mockResolvedValue({ status: 'committed', messages: [first] }),
    reconcileConversationBranch: vi.fn().mockResolvedValue({ status: 'committed', messages: [first] }),
  };
  const deps = createConversationControllerDeps({ getExecutionCoordinator: () => coordinator });
  deps.state.currentConversationId = 'conversation';
  deps.state.messages = [first, prompt];
  vi.mocked(deps.plugin.updateConversation).mockRejectedValueOnce(new Error('Save unavailable'));
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
    navigateConversationBranch: vi.fn().mockResolvedValueOnce({ status: 'recovery-required', error: 'Reply lost' })
      .mockResolvedValue({ status: 'committed', messages: [first] }),
    reconcileConversationBranch: vi.fn().mockResolvedValue({ status: 'cancelled', messages: [first, { ...prompt, id: 'reloaded' }] }),
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
    navigateConversationBranch: vi.fn().mockResolvedValue({ status: 'recovery-required', error: 'Reply lost' }),
    reconcileConversationBranch: vi.fn(),
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

it('carries the live project paragraph on branch navigation and recovery, and drops it once the project is deleted', async () => {
  const record = projectRecord({ id: 'project-1', name: 'Launch' });
  const projects = createProjectsFake([record]);
  const first = { id: 'first', role: 'user' as const, content: 'First', timestamp: testDate().getTime() };
  const prompt = { id: 'second', role: 'user' as const, content: 'Second', timestamp: testDate().getTime(), userMessageId: 'native-second' };
  const coordinator = {
    workingDirectory: '/vault',
    navigateConversationBranch: vi.fn().mockResolvedValue({ status: 'recovery-required', error: 'Moved' }),
    reconcileConversationBranch: vi.fn().mockResolvedValue({ status: 'recovery-required', error: 'Still moving' }),
  };
  const deps = createConversationControllerDeps({ getExecutionCoordinator: () => coordinator, getSelectedModel: () => 'model-a' });
  Object.assign(deps.plugin, {
    projects,
    getConversationSummary: (id: string) => ({ id, providerId: 'claude', projectId: record.id }),
    // The prompt names the coordinator's captured directory, never a later host value.
    providerHost: { workingDirectory: '/moved-vault' },
  });
  deps.state.currentConversationId = 'conversation';
  deps.state.messages = [first, prompt];
  const controller = new ConversationController(deps);
  await controller.navigateBranch('second');
  deps.getInputEl().value = 'Edited';
  await controller.commitBranchDraft();
  projects.remove(record.id);
  await controller.commitBranchDraft();

  const member = { model: 'model-a', systemInstructions: {
    kind: 'main-agent', instructions: buildSystemPrompt({ userName: '', vaultPath: '/vault', sessionInstructions: renderProjectMemberInstructions(record) }),
  } };
  expect(coordinator.navigateConversationBranch).toHaveBeenCalledWith(expect.objectContaining({ configuration: member }));
  // Each recovery attempt resolves the project again: the first follows navigation, the later two the deletion.
  const normal = { model: 'model-a', systemInstructions: { kind: 'main-agent', instructions: buildSystemPrompt({ userName: '', vaultPath: '/vault' }) } };
  expect(coordinator.reconcileConversationBranch.mock.calls.map(([request]) => request.configuration)).toEqual([member, normal, normal]);
});
