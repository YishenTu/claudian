import '@/providers';

import { ClaudianSettingTab } from '@/features/settings/ClaudianSettings';

describe('ClaudianSettingTab model option updates', () => {
  it('refreshes provider-scoped chat selectors and the live title model menu together', () => {
    const refreshModelSelector = jest.fn();
    const plugin = {
      getAllViews: jest.fn(() => [{ refreshModelSelector }]),
      notifyAgentSkillsChanged: jest.fn(),
      storage: {
        getAdapter: jest.fn(() => ({})),
      },
    };
    const tab = new ClaudianSettingTab({} as any, plugin as any);
    const refreshTitleModelOptions = jest.fn();
    (tab as any).refreshTitleModelOptions = refreshTitleModelOptions;

    (tab as any).notifyProviderModelOptionsChanged('codex');

    expect(refreshModelSelector).toHaveBeenCalledWith('codex');
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
});
