import { reorderProviderModelIds } from '@/shared/settings/ProviderModelPicker';

describe('reorderProviderModelIds', () => {
  it('moves a selected model to the requested index without changing the others', () => {
    expect(reorderProviderModelIds(
      ['model-a', 'model-b', 'model-c'],
      'model-c',
      0,
    )).toEqual(['model-c', 'model-a', 'model-b']);
  });

  it('clamps movement to the selected list boundaries', () => {
    expect(reorderProviderModelIds(
      ['model-a', 'model-b', 'model-c'],
      'model-a',
      99,
    )).toEqual(['model-b', 'model-c', 'model-a']);
  });

  it('leaves the order unchanged for an unknown model', () => {
    expect(reorderProviderModelIds(
      ['model-a', 'model-b'],
      'model-c',
      0,
    )).toEqual(['model-a', 'model-b']);
  });
});
