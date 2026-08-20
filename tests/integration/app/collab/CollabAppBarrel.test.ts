import * as collab from '@/app/collab';

describe('Collab application composition barrel', () => {
  it('exposes only composition values', () => {
    expect(Object.keys(collab).sort()).toEqual([
      'ClaudianCollabService',
      'CollabFeatureService',
      'CollabProjectSetupService',
      'createCollabFeatureSubcomposition',
    ]);
  });
});
