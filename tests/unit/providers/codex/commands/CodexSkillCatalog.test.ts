import { CodexSkillCatalog } from '@/providers/codex/commands/CodexSkillCatalog';
import type { SkillMetadata } from '@/providers/codex/runtime/codexAppServerTypes';
import type { CodexSkillListProvider } from '@/providers/codex/skills/CodexSkillListingService';

function createListProvider(skills: SkillMetadata[] = []): jest.Mocked<CodexSkillListProvider> {
  return {
    listSkills: jest.fn().mockResolvedValue(skills),
    invalidate: jest.fn(),
  };
}

describe('CodexSkillCatalog', () => {
  it('uses app-server metadata as its only runtime source', async () => {
    const listProvider = createListProvider([
      {
        name: 'shared-skill',
        description: 'Portable shared skill',
        path: '/workspace/.agents/skills/shared-skill/SKILL.md',
        scope: 'repo',
        enabled: true,
      },
      {
        name: 'legacy-skill',
        description: 'Provider-native legacy skill',
        path: '/workspace/.codex/skills/legacy-skill/SKILL.md',
        scope: 'repo',
        enabled: true,
      },
      {
        name: 'home-skill',
        description: 'User skill',
        path: '/home/user/.agents/skills/home-skill/SKILL.md',
        scope: 'user',
        enabled: true,
      },
    ]);
    const catalog = new CodexSkillCatalog(listProvider);
    const signal = new AbortController().signal;

    const entries = await catalog.listDropdownEntries({
      includeBuiltIns: false,
      signal,
    });

    expect(listProvider.listSkills).toHaveBeenCalledWith({ signal });
    expect(entries.map(entry => entry.name)).toEqual([
      'legacy-skill',
      'shared-skill',
      'home-skill',
    ]);
    expect(entries[0]).toMatchObject({
      scope: 'vault',
      isEditable: false,
      isDeletable: false,
      displayPrefix: '$',
      insertPrefix: '$',
    });
    expect(entries[0].persistenceKey).toBeUndefined();
    expect(entries[1].persistenceKey).toBeUndefined();
    expect(entries[2].scope).toBe('user');
  });

  it('preserves the exact app-server skill name and filters disabled skills', async () => {
    const listProvider = createListProvider([
      {
        name: 'scope:qualified-name',
        description: 'Qualified',
        path: '/workspace/.agents/skills/qualified-name/SKILL.md',
        scope: 'repo',
        enabled: true,
      },
      {
        name: 'disabled-skill',
        description: 'Disabled',
        path: '/workspace/.agents/skills/disabled-skill/SKILL.md',
        scope: 'repo',
        enabled: false,
      },
    ]);
    const catalog = new CodexSkillCatalog(listProvider);

    const entries = await catalog.listDropdownEntries({ includeBuiltIns: false });

    expect(entries.map(entry => entry.name)).toEqual(['scope:qualified-name']);
  });

  it('includes the provider built-in only when requested', async () => {
    const catalog = new CodexSkillCatalog(createListProvider());

    await expect(catalog.listDropdownEntries({ includeBuiltIns: true })).resolves.toEqual([
      expect.objectContaining({ name: 'compact', insertPrefix: '/' }),
    ]);
    await expect(catalog.listDropdownEntries({ includeBuiltIns: false })).resolves.toEqual([]);
  });

  it('force-refreshes only through the app-server list provider', async () => {
    const listProvider = createListProvider();
    const catalog = new CodexSkillCatalog(listProvider);

    await catalog.refresh();

    expect(listProvider.invalidate).toHaveBeenCalledTimes(1);
    expect(listProvider.listSkills).toHaveBeenCalledWith({ forceReload: true });
  });
});
