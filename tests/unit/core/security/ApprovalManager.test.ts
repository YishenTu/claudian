
import {
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

  it('returns null when file_path is missing', () => {
    expect(getActionPattern('Read', {})).toBeNull();
  });

  it('extracts notebook_path for NotebookEdit tool', () => {
    expect(getActionPattern('NotebookEdit', { notebook_path: '/test/notebook.ipynb' })).toBe('/test/notebook.ipynb');
  });

  it('falls back to file_path for NotebookEdit when notebook_path is missing', () => {
    expect(getActionPattern('NotebookEdit', { file_path: '/test/notebook.ipynb' })).toBe('/test/notebook.ipynb');
  });

  it('returns null for NotebookEdit when both paths are missing', () => {
    expect(getActionPattern('NotebookEdit', {})).toBeNull();
  });

  it('returns null when file_path is empty string', () => {
    expect(getActionPattern('Read', { file_path: '' })).toBeNull();
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
    expect(matchesRulePattern('Bash', 'npm', 'npm:*')).toBe(true);
  });

  it('does not match when action pattern is null', () => {
    expect(matchesRulePattern('Read', null, '/test/vault/')).toBe(false);
    expect(matchesRulePattern('Read', null, '*')).toBe(false);
  });

  it('still matches when no rule pattern and action is null', () => {
    expect(matchesRulePattern('Read', null, undefined)).toBe(true);
  });
});
