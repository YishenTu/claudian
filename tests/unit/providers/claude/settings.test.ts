import {
  DEFAULT_CLAUDE_PROVIDER_SETTINGS,
  getClaudeProviderSettings,
  updateClaudeProviderSettings,
} from '@/providers/claude/settings';

describe('Claude usage guard settings', () => {
  it('defaults to disabled with a 90% threshold', () => {
    expect(DEFAULT_CLAUDE_PROVIDER_SETTINGS.usageGuardEnabled).toBe(false);
    expect(DEFAULT_CLAUDE_PROVIDER_SETTINGS.usageGuardThresholdPercent).toBe(90);
  });

  it('reads defaults from an empty settings bag', () => {
    const settings = getClaudeProviderSettings({});
    expect(settings.usageGuardEnabled).toBe(false);
    expect(settings.usageGuardThresholdPercent).toBe(90);
  });

  it('persists updates via updateClaudeProviderSettings', () => {
    const bag: Record<string, unknown> = {};
    updateClaudeProviderSettings(bag, { usageGuardEnabled: true, usageGuardThresholdPercent: 75 });

    const settings = getClaudeProviderSettings(bag);
    expect(settings.usageGuardEnabled).toBe(true);
    expect(settings.usageGuardThresholdPercent).toBe(75);
  });

  it('clamps out-of-range threshold values on read', () => {
    const bag: Record<string, unknown> = {
      providerConfigs: { claude: { usageGuardThresholdPercent: 500 } },
    };
    expect(getClaudeProviderSettings(bag).usageGuardThresholdPercent).toBe(100);

    const negativeBag: Record<string, unknown> = {
      providerConfigs: { claude: { usageGuardThresholdPercent: -10 } },
    };
    expect(getClaudeProviderSettings(negativeBag).usageGuardThresholdPercent).toBe(1);
  });
});
