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
});
