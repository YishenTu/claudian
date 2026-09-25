
import {
  getActionDescription,
  getActionPattern,
} from '../../../../src/core/security/approvalRules';

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
