import { findClaudeModelOption, getClaudeModelOptions } from '@/providers/claude/modelOptions';

const settings = (config: Record<string, unknown>) => ({ providerConfigs: { claude: config } });

describe('Claude SDK model catalog', () => {
  it.each([
    { selected: 'opus', ids: ['default', 'opus[1m]'], expected: 'opus[1m]' },
    { selected: 'fable', ids: ['claude-fable-5-1'], expected: 'claude-fable-5-1' },
    { selected: 'sonnet', ids: ['sonnet', 'sonnet[1m]'], expected: 'sonnet' },
    { selected: 'opus', ids: ['claude-opus-5-5', 'opus[1m]'], expected: 'claude-opus-5-5' },
    { selected: 'opus', ids: ['opus[1m]', 'claude-opus-5-5'], expected: 'claude-opus-5-5' },
    { selected: 'opus', ids: ['default'], expected: undefined },
    { selected: 'opus', ids: ['custom'], expected: 'custom' },
    { selected: 'opus[1m]', ids: ['claude-opus-5-5'], expected: undefined },
    { selected: 'opus[1m]', ids: ['claude-opus-5-5', 'claude-opus-5-5[1m]'], expected: 'claude-opus-5-5[1m]' },
    { selected: 'claude-opus-4', ids: ['claude-opus-5-5'], expected: 'claude-opus-5-5' },
    { selected: 'claude-opus-4-1-20250805', ids: ['opus[1m]'], expected: 'opus[1m]' },
    { selected: 'claude-opus-4[1m]', ids: ['claude-opus-5-5'], expected: undefined },
    { selected: 'custom', ids: ['claude-opus-5-5'], expected: undefined },
  ])('resolves $selected from $ids with exact identities ahead of family successors', ({ selected, ids, expected }) => {
    const options = ids.map(value => ({ value, label: value, description: '', resolvedModel: 'claude-opus-5-5' }));
    expect(findClaudeModelOption(options, selected)?.value).toBe(expected);
  });

  it.each([
    { ids: ['claude-fable-5-2', 'claude-fable-5-10'], expected: 'claude-fable-5-10' },
    { ids: ['claude-fable-5-10', 'claude-fable-5-2'], expected: 'claude-fable-5-10' },
    { ids: ['claude-fable-5-10', 'claude-fable-6-0'], expected: 'claude-fable-6-0' },
    { ids: ['claude-fable-6-0', 'fable'], expected: 'fable' },
  ])('selects the highest numeric family version from $ids', ({ ids, expected }) => {
    const options = ids.map(value => ({ value, label: value, description: '' }));
    expect(findClaudeModelOption(options, 'fable')?.value).toBe(expected);
  });

  it.each([
    { ids: ['claude-opus-4-20250514', 'claude-opus-4-1-20250805'], expected: 'claude-opus-4-1-20250805' },
    { ids: ['claude-opus-4-1-20250805', 'claude-opus-4-20250514'], expected: 'claude-opus-4-1-20250805' },
    { ids: ['claude-opus-4-20250514', 'claude-opus-4-1'], expected: 'claude-opus-4-1' },
    { ids: ['claude-opus-4-1', 'claude-opus-4-1-20250805'], expected: 'claude-opus-4-1' },
  ])('ranks model versions independently of snapshot dates in $ids', ({ ids, expected }) => {
    const options = ids.map(value => ({ value, label: value, description: '' }));
    expect(findClaudeModelOption(options, 'opus')?.value).toBe(expected);
  });

  it('ranks aliases by their resolved version and prefers standard context on ties', () => {
    const options = [
      { value: 'claude-opus-5-2', label: 'Older', description: '' },
      { value: 'opus[1m]', label: 'Newer', description: '', resolvedModel: 'claude-opus-5-10[1m]' },
      { value: 'claude-opus-5-10', label: 'Same version', description: '' },
      { value: 'claude-opus-5-10-20260101', label: 'Same version snapshot', description: '' },
    ];
    expect(findClaudeModelOption(options, 'opus')?.value).toBe('claude-opus-5-10');
    expect(findClaudeModelOption(options, 'opus[1m]')?.value).toBe('opus[1m]');
    expect(findClaudeModelOption(options, 'claude-sonnet-4')).toBeUndefined();
  });

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
