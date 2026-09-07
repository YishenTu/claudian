import { buildPersistentPermissionUpdates } from '@/providers/claude/security/ClaudePermissionUpdates';

describe('buildPersistentPermissionUpdates', () => {
  it('constructs a project allow rule from the action', () => {
    const updates = buildPersistentPermissionUpdates('Bash', { command: 'git status' });
    expect(updates).toEqual([{
      type: 'addRules',
      behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: 'git status' }],
      destination: 'projectSettings',
    }]);
  });

  it('uses SDK suggestions when available', () => {
    const suggestions = [{
      type: 'addRules' as const,
      behavior: 'allow' as const,
      rules: [{ toolName: 'Bash', ruleContent: 'git *' }],
      destination: 'session' as const,
    }];
    const updates = buildPersistentPermissionUpdates('Bash', { command: 'git status' }, suggestions);
    expect(updates).toEqual([{
      type: 'addRules',
      behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: 'git *' }],
      destination: 'projectSettings',
    }]);
  });

  it('falls back to constructed rule when no addRules suggestions', () => {
    const updates = buildPersistentPermissionUpdates('Bash', { command: 'ls' }, []);
    expect(updates).toEqual([{
      type: 'addRules',
      behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: 'ls' }],
      destination: 'projectSettings',
    }]);
  });

  it('does not persist an unscoped fallback rule', () => {
    expect(buildPersistentPermissionUpdates('Read', {})).toEqual([]);
  });

  it('includes addDirectories suggestions without overriding destination', () => {
    const suggestions = [
      {
        type: 'addRules' as const,
        behavior: 'allow' as const,
        rules: [{ toolName: 'Read', ruleContent: '/external/path/*' }],
        destination: 'session' as const,
      },
      {
        type: 'addDirectories' as const,
        directories: ['/external/path'],
        destination: 'session' as const,
      },
    ];
    const updates = buildPersistentPermissionUpdates('Read', { file_path: '/external/path/file.md' }, suggestions);
    expect(updates).toHaveLength(2);
    expect(updates[0]).toEqual({
      type: 'addRules',
      behavior: 'allow',
      rules: [{ toolName: 'Read', ruleContent: '/external/path/*' }],
      destination: 'projectSettings',
    });
    expect(updates[1]).toEqual({
      type: 'addDirectories',
      directories: ['/external/path'],
      destination: 'session',
    });
  });

  it('includes removeDirectories suggestions without overriding destination', () => {
    const suggestions = [
      {
        type: 'removeDirectories' as const,
        directories: ['/revoked/path'],
        destination: 'session' as const,
      },
    ];
    const updates = buildPersistentPermissionUpdates('Bash', { command: 'ls' }, suggestions);
    expect(updates).toHaveLength(2);
    expect(updates[0]).toEqual({
      type: 'addRules',
      behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: 'ls' }],
      destination: 'projectSettings',
    });
    expect(updates[1]).toEqual({
      type: 'removeDirectories',
      directories: ['/revoked/path'],
      destination: 'session',
    });
  });

  it('includes setMode suggestions without overriding destination', () => {
    const suggestions = [
      {
        type: 'setMode' as const,
        mode: 'default' as const,
        destination: 'session' as const,
      },
    ];
    const updates = buildPersistentPermissionUpdates('Bash', { command: 'echo hi' }, suggestions);
    expect(updates).toHaveLength(2);
    expect(updates[0]).toEqual({
      type: 'addRules',
      behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: 'echo hi' }],
      destination: 'projectSettings',
    });
    expect(updates[1]).toEqual({
      type: 'setMode',
      mode: 'default',
      destination: 'session',
    });
  });

  it('prepends constructed addRules when suggestions have no addRules type', () => {
    const suggestions = [
      {
        type: 'addDirectories' as const,
        directories: ['/new/dir'],
        destination: 'session' as const,
      },
    ];
    const updates = buildPersistentPermissionUpdates('Read', { file_path: '/new/dir/file.md' }, suggestions);
    expect(updates).toHaveLength(2);
    expect(updates[0].type).toBe('addRules');
    expect(updates[1].type).toBe('addDirectories');
  });

  it('does not prepend addRules when replaceRules suggestion is present', () => {
    const suggestions = [
      {
        type: 'replaceRules' as const,
        behavior: 'allow' as const,
        rules: [{ toolName: 'Bash', ruleContent: 'git *' }],
        destination: 'session' as const,
      },
    ];
    const updates = buildPersistentPermissionUpdates('Bash', { command: 'git status' }, suggestions);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      type: 'replaceRules',
      behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: 'git *' }],
      destination: 'projectSettings',
    });
  });

  it('prepends addRules when only removeRules suggestion is present', () => {
    const suggestions = [
      {
        type: 'removeRules' as const,
        behavior: 'allow' as const,
        rules: [{ toolName: 'Bash', ruleContent: 'old-pattern' }],
        destination: 'session' as const,
      },
    ];
    const updates = buildPersistentPermissionUpdates('Bash', { command: 'git status' }, suggestions);
    expect(updates).toHaveLength(2);
    expect(updates[0].type).toBe('addRules');
    expect(updates[0]).toMatchObject({
      behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: 'git status' }],
      destination: 'projectSettings',
    });
    expect(updates[1].type).toBe('removeRules');
  });

  it('preserves original behavior on removeRules suggestions', () => {
    const suggestions = [
      {
        type: 'removeRules' as const,
        behavior: 'deny' as const,
        rules: [{ toolName: 'Bash', ruleContent: 'git status' }],
        destination: 'session' as const,
      },
    ];
    const updates = buildPersistentPermissionUpdates('Bash', { command: 'git status' }, suggestions);
    const removeEntry = updates.find(u => u.type === 'removeRules');
    expect(removeEntry).toBeDefined();
    expect(removeEntry!.behavior).toBe('deny');
    expect(removeEntry!.destination).toBe('session');
  });

  it('returns no persistent update when neither suggestions nor fallback have a non-empty scope', () => {
    expect(buildPersistentPermissionUpdates('Read', {})).toEqual([]);
    expect(buildPersistentPermissionUpdates('Bash', { command: '   ' })).toEqual([]);
    expect(buildPersistentPermissionUpdates('UnknownTool', {})).toEqual([]);
  });

  it('ignores whitespace-only suggested scopes for persistent approval', () => {
    const suggestions = [{
      type: 'addRules' as const,
      behavior: 'allow' as const,
      rules: [{ toolName: 'Read', ruleContent: '   ' }],
      destination: 'session' as const,
    }];

    expect(buildPersistentPermissionUpdates('Read', {}, suggestions)).toEqual([]);
  });

  it('preserves the exact non-empty provider suggestion for persistent approval', () => {
    const suggestions = [{
      type: 'addRules' as const,
      behavior: 'deny' as const,
      rules: [{ toolName: 'Bash', ruleContent: 'git *' }],
      destination: 'session' as const,
    }];

    expect(buildPersistentPermissionUpdates('Bash', {}, suggestions)).toEqual([{
      type: 'addRules',
      behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: 'git *' }],
      destination: 'projectSettings',
    }]);
  });
});
