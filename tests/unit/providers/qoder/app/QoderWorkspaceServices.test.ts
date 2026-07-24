import { resolveQoderRefreshedVisibleModels } from '@/providers/qoder/app/QoderWorkspaceServices';

describe('resolveQoderRefreshedVisibleModels', () => {
  const nextModels = [
    { isDefault: true, rawId: 'auto' },
    { isDefault: false, rawId: 'performance' },
    { isDefault: false, rawId: 'ultimate' },
  ];

  it('selects provider defaults on first discovery', () => {
    expect(resolveQoderRefreshedVisibleModels([], [], nextModels)).toEqual([
      'qoder/auto',
    ]);
  });

  it('preserves user visibility choices across catalog refreshes', () => {
    expect(resolveQoderRefreshedVisibleModels(
      [{ rawId: 'auto' }, { rawId: 'performance' }],
      ['qoder/performance'],
      nextModels,
    )).toEqual(['qoder/performance']);
  });

  it('falls back to current defaults when all selected models disappeared', () => {
    expect(resolveQoderRefreshedVisibleModels(
      [{ rawId: 'retired' }],
      ['qoder/retired'],
      nextModels,
    )).toEqual(['qoder/auto']);
  });
});
