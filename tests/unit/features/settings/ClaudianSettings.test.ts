import '@/providers';

import { ClaudianSettingTab } from '@/features/settings/ClaudianSettings';

describe('ClaudianSettingTab model option updates', () => {
  it('refreshes provider-scoped chat selectors and the live title model menu together', () => {
    const refreshModelSelector = jest.fn();
    const notifyProviderChatOptionsChanged = jest.fn();
    const plugin = {
      getAllViews: jest.fn(() => [{ refreshModelSelector }]),
      notifyProviderChatOptionsChanged,
      notifyAgentSkillsChanged: jest.fn(),
      storage: {
        getAdapter: jest.fn(() => ({})),
      },
    };
    const tab = new ClaudianSettingTab({} as any, plugin as any);
    const refreshTitleModelOptions = jest.fn();
    (tab as any).refreshTitleModelOptions = refreshTitleModelOptions;

    (tab as any).notifyProviderModelOptionsChanged('codex');

    expect(notifyProviderChatOptionsChanged).toHaveBeenCalledWith('codex');
    expect(refreshModelSelector).not.toHaveBeenCalled();
    expect(refreshTitleModelOptions).toHaveBeenCalledTimes(1);
  });

  it('invalidates provider executions when prompt settings change', async () => {
    const runProviderExecutionTransition = jest.fn(async (
      _providerIds: string[],
      mutation: () => Promise<void>,
    ) => mutation());
    const plugin = {
      providerHost: { runProviderExecutionTransition },
      settings: {},
      storage: {
        getAdapter: jest.fn(() => ({})),
      },
    };
    const tab = new ClaudianSettingTab({} as any, plugin as any);

    await (tab as any).restartServiceForPromptChange();

    expect(runProviderExecutionTransition).toHaveBeenCalledWith(
      expect.arrayContaining(['claude', 'codex', 'grok', 'opencode', 'pi']),
      expect.any(Function),
    );
  });

  it('refreshes open provider views after a custom context limit changes', async () => {
    jest.useFakeTimers();
    const settings = { customContextLimits: {} as Record<string, number> };
    const notifyProviderChatOptionsChanged = jest.fn();
    const plugin = {
      getAllViews: jest.fn(() => []),
      notifyProviderChatOptionsChanged,
      notifyAgentSkillsChanged: jest.fn(),
      mutateSettings: jest.fn(async (mutation: (value: typeof settings) => void) => {
        mutation(settings);
      }),
      settings,
      storage: {
        getAdapter: jest.fn(() => ({})),
      },
    };
    const tab = new ClaudianSettingTab({} as any, plugin as any);

    await (tab as any).updateCustomContextLimit('codex', 'my-custom-model', 1_000_000);

    expect(settings.customContextLimits['my-custom-model']).toBe(1_000_000);
    expect(notifyProviderChatOptionsChanged).not.toHaveBeenCalled();
    jest.advanceTimersByTime(150);
    expect(notifyProviderChatOptionsChanged).toHaveBeenCalledWith('codex');
    jest.useRealTimers();
  });
});
