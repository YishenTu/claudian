import { qoderChatUIConfig } from '@/providers/qoder/ui/QoderChatUIConfig';

function createSettings() {
  return {
    providerConfigs: {
      qoder: {
        discoveredModels: [
          {
            contextWindow: 180_000,
            contextWindowIsAuthoritative: true,
            displayName: 'Auto',
            isDefault: true,
            rawId: 'auto',
            reasoningEfforts: [],
            supportsReasoning: false,
          },
          {
            contextWindow: 272_000,
            contextWindowIsAuthoritative: true,
            defaultEffort: 'medium',
            displayName: 'Performance',
            isDefault: false,
            rawId: 'performance',
            reasoningEfforts: [
              { label: 'Low', value: 'low' },
              { label: 'Medium', value: 'medium' },
              { label: 'High', value: 'high' },
              { label: 'Max', value: 'max' },
            ],
            supportsReasoning: true,
          },
        ],
        visibleModels: ['qoder/auto', 'qoder/performance'],
      },
    },
  };
}

describe('qoderChatUIConfig reasoning controls', () => {
  it('offers the four CLI effort levels for Auto', () => {
    const settings = createSettings();

    expect(qoderChatUIConfig.isAdaptiveReasoningModel('qoder/auto', settings)).toBe(true);
    expect(qoderChatUIConfig.getReasoningOptions('qoder/auto', settings)).toEqual([
      { label: 'Low', value: 'low' },
      { label: 'Medium', value: 'medium' },
      { label: 'High', value: 'high' },
      { label: 'Max', value: 'max' },
    ]);
  });

  it('uses the model-declared default effort', () => {
    expect(
      qoderChatUIConfig.getDefaultReasoningValue('qoder/performance', createSettings()),
    ).toBe('medium');
  });

  it('preserves a supported effort while projecting the selected model', () => {
    const settings = {
      ...createSettings(),
      effortLevel: 'low',
    };

    qoderChatUIConfig.applyModelProjectionDefaults?.('qoder/auto', settings);

    expect(settings.effortLevel).toBe('low');
  });
});
