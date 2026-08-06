import {
  assessProviderReadiness,
  type ProviderReadinessInput,
} from '@/core/providers/ProviderReadiness';

describe('assessProviderReadiness', () => {
  const baseInput: ProviderReadinessInput = {
    cliPath: '/usr/local/bin/omp',
    discoveredModelCount: 3,
    selectedModelCount: 2,
    enabled: true,
  };

  it('reports a provider as ready when it can reach a selected model', () => {
    expect(assessProviderReadiness(baseInput)).toEqual({
      status: 'ready',
      checks: [
        { id: 'enabled', status: 'ready' },
        { id: 'cli', status: 'ready' },
        { id: 'models', status: 'ready' },
        { id: 'selection', status: 'ready' },
      ],
    });
  });

  it('identifies the first actionable gaps when the provider is enabled but not configured', () => {
    expect(assessProviderReadiness({
      ...baseInput,
      cliPath: null,
      discoveredModelCount: 0,
      selectedModelCount: 0,
    })).toMatchObject({
      status: 'blocked',
      checks: [
        { id: 'enabled', status: 'ready' },
        { id: 'cli', status: 'blocked', remediation: 'configureCli' },
        { id: 'models', status: 'attention', remediation: 'refreshModels' },
        { id: 'selection', status: 'blocked', remediation: 'selectModel' },
      ],
    });
  });

  it('treats a disabled provider as intentionally inactive', () => {
    expect(assessProviderReadiness({
      ...baseInput,
      enabled: false,
    })).toMatchObject({
      status: 'disabled',
      checks: [
        { id: 'enabled', status: 'disabled', remediation: 'enableProvider' },
        { id: 'cli', status: 'disabled' },
        { id: 'models', status: 'disabled' },
        { id: 'selection', status: 'disabled' },
      ],
    });
  });
});
