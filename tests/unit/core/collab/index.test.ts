import type {
  CollabComposerReferencePort,
  CollabFeaturePort,
  CollabProjectSelectionProjection,
  CollabResult,
} from '@/core/collab';
import * as coreCollab from '@/core/collab';

describe('Collab core barrel', () => {
  it('exposes only client-only Collab contracts', () => {
    // The shared wire contract lives in @claudian/collab-protocol. This barrel
    // must not re-export package symbols or grow a second registry.
    expect(Object.keys(coreCollab).sort()).toEqual([
      'DEFAULT_COLLAB_PROJECTS_FOLDER',
      'parseCollabProjectsFolder',
      'resolveEffectiveCollabProjectId',
    ]);
  });

  it('keeps the client-facing port vocabulary available', () => {
    const featurePort: CollabFeaturePort | null = null;
    const composerPort: CollabComposerReferencePort | null = null;
    const projection: CollabProjectSelectionProjection | null = null;
    const result: CollabResult<void> = { status: 'success', value: undefined };

    expect(featurePort).toBeNull();
    expect(composerPort).toBeNull();
    expect(projection).toBeNull();
    expect(result.status).toBe('success');
  });
});
