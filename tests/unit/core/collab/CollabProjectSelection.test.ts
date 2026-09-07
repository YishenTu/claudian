import { resolveEffectiveCollabProjectId } from '@/core/collab/CollabProjectSelection';

describe('resolveEffectiveCollabProjectId', () => {
  const projects = [{ id: 'project-a' }, { id: 'project-b' }];

  it('uses a valid persisted selection', () => {
    expect(resolveEffectiveCollabProjectId(projects, 'project-b')).toBe('project-b');
  });

  it('falls back to the first Project when the selection is absent or stale', () => {
    expect(resolveEffectiveCollabProjectId(projects, null)).toBe('project-a');
    expect(resolveEffectiveCollabProjectId(projects, 'project-missing')).toBe('project-a');
    expect(resolveEffectiveCollabProjectId([], 'project-missing')).toBeNull();
  });
});
