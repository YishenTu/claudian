import { getClaudeModelOptions } from '@/providers/claude/modelOptions';

const settings = (config: Record<string, unknown>) => ({ providerConfigs: { claude: config } });

describe('Claude SDK model catalog', () => {
  it('does not invent models from defaults, environment or the retired manual field', () => {
    expect(getClaudeModelOptions(settings({
      customModels: 'manual-model',
      environmentVariables: 'ANTHROPIC_MODEL=env-model',
    }))).toEqual([]);
  });

  it('omits the SDK default while preserving custom models and distinct variants', () => {
    expect(getClaudeModelOptions(settings({
      discoveredModels: [
        { value: 'default', label: 'Default', description: 'SDK default' },
        { value: 'sonnet', label: 'Sonnet', description: '', resolvedModel: 'shared' },
        { value: 'sonnet[1m]', label: 'Sonnet 1M', description: '', resolvedModel: 'shared' },
        { value: 'custom', label: 'Gateway', description: 'From SDK' },
      ],
      visibleModels: ['default', 'sonnet[1m]', 'custom'],
    }))).toEqual([
      expect.objectContaining({ value: 'claude-code/sonnet[1m]', label: 'Sonnet 1M' }),
      expect.objectContaining({ value: 'claude-code/custom', label: 'Gateway' }),
    ]);
  });

  it('respects an explicitly empty enabled list', () => {
    expect(getClaudeModelOptions(settings({
      discoveredModels: [{ value: 'sonnet', label: 'Sonnet', description: '' }],
      visibleModels: [],
    }))).toEqual([]);
  });
});
