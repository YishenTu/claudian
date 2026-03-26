import { buildPermissionUpdates } from '@/providers/claude/security/ClaudePermissionUpdates';

describe('buildPermissionUpdates', () => {
  it('constructs allow rule for allow decision', () => {
    const updates = buildPermissionUpdates('Bash', { command: 'git status' }, 'allow');
    expect(updates).toEqual([{
      type: 'addRules',
      behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: 'git status' }],
      destination: 'session',
    }]);
  });

  it('uses projectSettings destination for always decisions', () => {
    const updates = buildPermissionUpdates('Bash', { command: 'git status' }, 'allow-always');
    expect(updates[0].destination).toBe('projectSettings');
  });

  it('uses SDK suggestions when available', () => {
    const suggestions = [{
      type: 'addRules' as const,
      behavior: 'allow' as const,
      rules: [{ toolName: 'Bash', ruleContent: 'git *' }],
      destination: 'session' as const,
    }];
    const updates = buildPermissionUpdates('Bash', { command: 'git status' }, 'allow-always', suggestions);
    expect(updates).toEqual([{
      type: 'addRules',
      behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: 'git *' }],
      destination: 'projectSettings',
    }]);
  });

  it('falls back to constructed rule when no addRules suggestions', () => {
    const updates = buildPermissionUpdates('Bash', { command: 'ls' }, 'allow', []);
    expect(updates).toEqual([{
      type: 'addRules',
      behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: 'ls' }],
      destination: 'session',
    }]);
  });

  it('omits ruleContent when pattern is null (missing file_path)', () => {
    const updates = buildPermissionUpdates('Read', {}, 'allow');
    expect(updates).toEqual([{
      type: 'addRules',
      behavior: 'allow',
      rules: [{ toolName: 'Read' }],
      destination: 'session',
    }]);
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
    const updates = buildPermissionUpdates('Read', { file_path: '/external/path/file.md' }, 'allow-always', suggestions);
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
    const updates = buildPermissionUpdates('Bash', { command: 'ls' }, 'allow-always', suggestions);
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
    const updates = buildPermissionUpdates('Bash', { command: 'echo hi' }, 'allow-always', suggestions);
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
    const updates = buildPermissionUpdates('Read', { file_path: '/new/dir/file.md' }, 'allow', suggestions);
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
    const updates = buildPermissionUpdates('Bash', { command: 'git status' }, 'allow-always', suggestions);
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
    const updates = buildPermissionUpdates('Bash', { command: 'git status' }, 'allow', suggestions);
    expect(updates).toHaveLength(2);
    expect(updates[0].type).toBe('addRules');
    expect(updates[0]).toMatchObject({
      behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: 'git status' }],
      destination: 'session',
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
    const updates = buildPermissionUpdates('Bash', { command: 'git status' }, 'allow-always', suggestions);
    const removeEntry = updates.find(u => u.type === 'removeRules');
    expect(removeEntry).toBeDefined();
    expect(removeEntry!.behavior).toBe('deny');
    expect(removeEntry!.destination).toBe('session');
  });
});
