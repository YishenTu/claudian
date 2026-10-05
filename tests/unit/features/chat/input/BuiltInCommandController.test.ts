import { createFixture } from '@test/helpers/ChatInputHarness';

jest.mock('@/core/providers/ProviderRegistry', () => ({
  ProviderRegistry: {
    getCapabilities: jest.fn().mockReturnValue({ providerId: 'claude', supportsFork: true }),
  },
}));

describe('composer /clear', () => {
  it('delegates /clear to the layout-owned New action when it handles the command', async () => {
    const handleNewConversationCommand = jest.fn().mockResolvedValue(true);
    const fixture = createFixture({ handleNewConversationCommand });
    fixture.linkedContentController.getSnapshot.mockReturnValue({
      content: null,
      mode: 'explicit-draft',
      path: 'Projects',
    });
    fixture.input.value = '/clear';

    await fixture.controller.sendMessage();

    expect(handleNewConversationCommand).toHaveBeenCalledTimes(1);
    expect(fixture.linkedContentController.resetAutoDraft).toHaveBeenCalledTimes(1);
    expect(fixture.deps.conversationController.createNew).not.toHaveBeenCalled();
  });

  it('clears the current tab in place when the layout does not handle /clear', async () => {
    const handleNewConversationCommand = jest.fn().mockResolvedValue(false);
    const fixture = createFixture({ handleNewConversationCommand });
    fixture.input.value = '/clear';

    await fixture.controller.sendMessage();

    expect(handleNewConversationCommand).toHaveBeenCalledTimes(1);
    expect(fixture.linkedContentController.resetAutoDraft).not.toHaveBeenCalled();
    expect(fixture.deps.conversationController.createNew).toHaveBeenCalledTimes(1);
  });

  it('does not unlock Linked content when layout-owned /clear leaves a bound tab', async () => {
    const handleNewConversationCommand = jest.fn().mockResolvedValue(true);
    const fixture = createFixture({ handleNewConversationCommand });
    fixture.input.value = '/clear';

    await fixture.controller.sendMessage();

    expect(fixture.linkedContentController.getSnapshot).toHaveBeenCalledTimes(1);
    expect(fixture.linkedContentController.resetAutoDraft).not.toHaveBeenCalled();
  });
});
