import '@/providers';

import { ClaudianSettingTab } from '@/features/settings/ClaudianSettings';

describe('ClaudianSettingTab model option updates', () => {
  it('refreshes provider-scoped chat selectors and the live title model menu together', () => {
    const refreshModelSelector = vi.fn();
    const notifyProviderChatOptionsChanged = vi.fn();
    const plugin = {
      getAllViews: vi.fn(() => [{ refreshModelSelector }]),
      notifyProviderChatOptionsChanged,
      notifyAgentSkillsChanged: vi.fn(),
      storage: {
        getAdapter: vi.fn(() => ({})),
      },
    };
    const tab = new ClaudianSettingTab({} as any, {} as any, plugin as any);
    const refreshTitleModelOptions = vi.fn();
    (tab as any).refreshTitleModelOptions = refreshTitleModelOptions;

    (tab as any).notifyProviderModelOptionsChanged('codex');

    expect(notifyProviderChatOptionsChanged).toHaveBeenCalledWith('codex');
    expect(refreshModelSelector).not.toHaveBeenCalled();
    expect(refreshTitleModelOptions).toHaveBeenCalledTimes(1);
  });

  it('invalidates provider executions when prompt settings change', async () => {
    const runProviderExecutionTransition = vi.fn(async (
      _providerIds: string[],
      mutation: () => Promise<void>,
    ) => mutation());
    const plugin = {
      providerHost: { runProviderExecutionTransition },
      settings: {},
      storage: {
        getAdapter: vi.fn(() => ({})),
      },
    };
    const tab = new ClaudianSettingTab({} as any, {} as any, plugin as any);

    await (tab as any).restartServiceForPromptChange();

    expect(runProviderExecutionTransition).toHaveBeenCalledWith(
      expect.arrayContaining(['claude', 'codex', 'grok', 'opencode', 'pi']),
      expect.any(Function),
    );
  });
});
