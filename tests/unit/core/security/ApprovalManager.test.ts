
import {
  buildPermissionUpdates,
  getActionDescription,
  getActionPattern,
  matchesRulePattern,
} from '../../../../src/core/security/ApprovalManager';

describe('getActionPattern', () => {
  it('extracts command from Bash tool input', () => {
    expect(getActionPattern('Bash', { command: 'git status' })).toBe('git status');
  });

  it('trims whitespace from Bash commands', () => {
    expect(getActionPattern('Bash', { command: '  git status  ' })).toBe('git status');
  });

  it('returns empty string for non-string Bash command', () => {
    expect(getActionPattern('Bash', { command: 123 })).toBe('');
  });

  it('extracts file_path for Read/Write/Edit tools', () => {
    expect(getActionPattern('Read', { file_path: '/test/file.md' })).toBe('/test/file.md');
    expect(getActionPattern('Write', { file_path: '/test/output.md' })).toBe('/test/output.md');
    expect(getActionPattern('Edit', { file_path: '/test/edit.md' })).toBe('/test/edit.md');
  });

  it('returns * when file_path is missing', () => {
    expect(getActionPattern('Read', {})).toBe('*');
  });

  it('extracts notebook_path for NotebookEdit tool', () => {
    expect(getActionPattern('NotebookEdit', { notebook_path: '/test/notebook.ipynb' })).toBe('/test/notebook.ipynb');
  });

  it('falls back to file_path for NotebookEdit when notebook_path is missing', () => {
    expect(getActionPattern('NotebookEdit', { file_path: '/test/notebook.ipynb' })).toBe('/test/notebook.ipynb');
  });

  it('returns * for NotebookEdit when both paths are missing', () => {
    expect(getActionPattern('NotebookEdit', {})).toBe('*');
  });

  it('returns * when file_path is empty string', () => {
    expect(getActionPattern('Read', { file_path: '' })).toBe('*');
  });

  it('extracts pattern for Glob/Grep tools', () => {
    expect(getActionPattern('Glob', { pattern: '**/*.md' })).toBe('**/*.md');
    expect(getActionPattern('Grep', { pattern: 'TODO' })).toBe('TODO');
  });

  it('returns JSON for unknown tools', () => {
    expect(getActionPattern('UnknownTool', { foo: 'bar' })).toBe('{"foo":"bar"}');
  });
});

describe('getActionDescription', () => {
  it('describes Bash tool actions', () => {
    expect(getActionDescription('Bash', { command: 'git status' })).toBe('Run command: git status');
  });

  it('describes file tool actions', () => {
    expect(getActionDescription('Read', { file_path: '/f.md' })).toBe('Read file: /f.md');
    expect(getActionDescription('Write', { file_path: '/f.md' })).toBe('Write to file: /f.md');
    expect(getActionDescription('Edit', { file_path: '/f.md' })).toBe('Edit file: /f.md');
  });

  it('describes search tool actions', () => {
    expect(getActionDescription('Glob', { pattern: '*.md' })).toBe('Search files matching: *.md');
    expect(getActionDescription('Grep', { pattern: 'TODO' })).toBe('Search content matching: TODO');
  });

  it('describes unknown tools with JSON', () => {
    expect(getActionDescription('Custom', { a: 1 })).toBe('Custom: {"a":1}');
  });
});

describe('matchesRulePattern', () => {
  it('matches when no rule pattern is provided', () => {
    expect(matchesRulePattern('Bash', 'git status', undefined)).toBe(true);
  });

  it('matches wildcard rule', () => {
    expect(matchesRulePattern('Bash', 'anything', '*')).toBe(true);
  });

  it('matches exact rule', () => {
    expect(matchesRulePattern('Bash', 'git status', 'git status')).toBe(true);
  });

  it('rejects non-matching Bash rule without wildcard', () => {
    expect(matchesRulePattern('Bash', 'git status', 'git commit')).toBe(false);
  });

  it('matches Bash wildcard prefix', () => {
    expect(matchesRulePattern('Bash', 'git status', 'git *')).toBe(true);
    expect(matchesRulePattern('Bash', 'git commit', 'git *')).toBe(true);
    expect(matchesRulePattern('Bash', 'npm install', 'git *')).toBe(false);
  });

  it('matches Bash CC-format colon wildcard', () => {
    expect(matchesRulePattern('Bash', 'npm install', 'npm:*')).toBe(true);
    expect(matchesRulePattern('Bash', 'npm run build', 'npm run:*')).toBe(true);
    expect(matchesRulePattern('Bash', 'yarn install', 'npm:*')).toBe(false);
  });

  it('does not allow Bash prefix collisions without a separator', () => {
    expect(matchesRulePattern('Bash', 'github status', 'git:*')).toBe(false);
    expect(matchesRulePattern('Bash', 'npmish install', 'npm:*')).toBe(false);
    expect(matchesRulePattern('Bash', 'npm runner build', 'npm run:*')).toBe(false);
  });

  it('matches file path prefix for Read tool', () => {
    expect(matchesRulePattern('Read', '/test/vault/notes/file.md', '/test/vault/')).toBe(true);
    expect(matchesRulePattern('Read', '/other/path/file.md', '/test/vault/')).toBe(false);
  });

  it('respects path segment boundaries', () => {
    expect(matchesRulePattern('Read', '/test/vault/notes/file.md', '/test/vault/notes')).toBe(true);
    expect(matchesRulePattern('Read', '/test/vault/notes2/file.md', '/test/vault/notes')).toBe(false);
  });

  it('matches exact file path (same length, no trailing slash)', () => {
    expect(matchesRulePattern('Read', '/test/vault/file.md', '/test/vault/file.md')).toBe(true);
  });

  it('matches file path with backslash normalization for same-length paths', () => {
    // Both normalize to the same path via backslash→forward slash replacement,
    // caught by the early exact match check (line 77) before isPathPrefixMatch.
    expect(matchesRulePattern('Write', '/test/vault\\file.md', '/test/vault/file.md')).toBe(true);
  });

  it('allows simple prefix matching for non-file, non-bash tools', () => {
    expect(matchesRulePattern('Glob', '**/*.md', '**/*')).toBe(true);
    expect(matchesRulePattern('Grep', 'TODO in file', 'TODO')).toBe(true);
  });

  it('returns false for non-file, non-bash tools when prefix does not match', () => {
    expect(matchesRulePattern('Glob', 'src/**', 'tests/**')).toBe(false);
  });

  it('matches exact Bash prefix without trailing space/wildcard via CC format', () => {
    // matchesBashPrefix exact match: action === prefix
    expect(matchesRulePattern('Bash', 'npm', 'npm:*')).toBe(true);
  });
});

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

  it('omits ruleContent for wildcard pattern', () => {
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
    // removeRules.behavior is NOT overridden — it specifies which list to remove from
    const updates = buildPermissionUpdates('Bash', { command: 'git status' }, 'allow-always', suggestions);
    const removeEntry = updates.find(u => u.type === 'removeRules');
    expect(removeEntry).toBeDefined();
    expect(removeEntry!.behavior).toBe('deny');
    expect(removeEntry!.destination).toBe('session');
  });
});
