import { migrateClaudeEffortMetadata } from '@/providers/claude/effortMetadataMigration';

const ALL_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

function row(value: string, extra: Record<string, unknown> = {}) {
  return { value, label: value, description: '', ...extra };
}

describe('migrateClaudeEffortMetadata', () => {
  it('fills missing or empty levels for the verified canonical ids', () => {
    expect(migrateClaudeEffortMetadata([
      row('claude-opus-5-5'),
      row('claude-sonnet-5', { supportedEffortLevels: [] }),
      row('claude-fable-5-1'),
    ]).map(model => model.supportedEffortLevels)).toEqual([ALL_LEVELS, ALL_LEVELS, ALL_LEVELS]);
  });

  it('recognizes the verified Fable [1m] selection id and keeps it unchanged', () => {
    expect(migrateClaudeEffortMetadata([
      row('claude-fable-5-1[1m]', { resolvedModel: 'claude-fable-5-1' }),
    ])).toEqual([
      row('claude-fable-5-1[1m]', { resolvedModel: 'claude-fable-5-1', supportedEffortLevels: ALL_LEVELS }),
    ]);
  });

  it('uses the saved resolved model for alias selections', () => {
    expect(migrateClaudeEffortMetadata([
      row('opus', { resolvedModel: 'claude-opus-5-5' }),
      row('sonnet', { resolvedModel: 'claude-sonnet-5' }),
    ]).map(model => model.supportedEffortLevels)).toEqual([ALL_LEVELS, ALL_LEVELS]);
  });

  it('leaves aliases without resolved models, older versions, custom models, Haiku, and ambiguous ids unchanged', () => {
    const untouched = [
      row('opus'),
      row('sonnet', { resolvedModel: 'claude-sonnet-4-6' }),
      row('claude-opus-4-7'),
      row('claude-sonnet-5[1m]'),
      row('custom-gateway-model'),
      row('haiku', { resolvedModel: 'claude-haiku-4-5' }),
      row('claude-opus-5-5', { resolvedModel: 'claude-opus-4-7' }),
    ];
    expect(migrateClaudeEffortMetadata(untouched)).toEqual(untouched);
  });

  it('preserves nonempty metadata and order', () => {
    const models = [
      row('claude-sonnet-5', { supportedEffortLevels: ['low', 'high'] }),
      row('claude-opus-5-5'),
    ];
    const migrated = migrateClaudeEffortMetadata(models);
    expect(migrated.map(model => model.value)).toEqual(['claude-sonnet-5', 'claude-opus-5-5']);
    expect(migrated[0].supportedEffortLevels).toEqual(['low', 'high']);
  });
});
