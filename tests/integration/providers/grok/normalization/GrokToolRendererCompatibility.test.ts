import {
  getToolLabel,
  getToolName,
  getToolSummary,
} from '@/features/chat/rendering/ToolCallRenderer';
import { normalizeGrokToolCall } from '@/providers/grok/normalization/grokToolNormalization';

describe('Grok tool renderer compatibility', () => {
  it.each([
    {
      expected: { label: 'Bash: printf ok', name: 'Bash', summary: 'printf ok' },
      rawInput: { command: 'printf ok', description: 'Diagnostic', is_background: false },
      rawName: 'run_terminal_command',
    },
    {
      expected: { label: 'Read: note.md', name: 'Read', summary: 'note.md' },
      rawInput: { limit: 5, offset: 1, target_file: 'note.md' },
      rawName: 'read_file',
    },
    {
      expected: { label: 'Read: note.md', name: 'Read', summary: 'note.md' },
      rawInput: { limit: 5, offset: 1, target_file: 'note.md' },
      rawName: 'hashline_read',
    },
    {
      expected: { label: 'Edit: note.md', name: 'Edit', summary: 'note.md' },
      rawInput: { file_path: 'note.md', new_string: 'new', old_string: 'old' },
      rawName: 'search_replace',
    },
    {
      expected: { label: 'Edit: note.md', name: 'Edit', summary: 'note.md' },
      rawInput: { edits: [{ anchor: '1:a', content: 'new', op: 'replace' }], file_path: 'note.md' },
      rawName: 'hashline_edit',
    },
    {
      expected: { label: 'LS: src', name: 'LS', summary: 'src' },
      rawInput: { target_directory: 'src' },
      rawName: 'list_dir',
    },
    {
      expected: { label: 'Grep: needle', name: 'Grep', summary: 'needle' },
      rawInput: { path: '.', pattern: 'needle' },
      rawName: 'hashline_grep',
    },
    {
      expected: { label: 'Skill: commit', name: 'Skill', summary: 'commit' },
      rawInput: { name: 'commit' },
      rawName: 'skill',
    },
    {
      expected: { label: 'ToolSearch: grok tools', name: 'ToolSearch', summary: 'grok tools' },
      rawInput: { query: 'grok tools' },
      rawName: 'search_tool',
    },
    {
      expected: { label: 'apply_patch: note.md', name: 'apply_patch', summary: 'note.md' },
      rawInput: { patch: '*** Begin Patch\n*** Update File: note.md\n*** End Patch' },
      rawName: 'apply_patch',
    },
  ])('$rawName matches its renderer contract', ({ expected, rawInput, rawName }) => {
    const normalized = normalizeGrokToolCall({ rawInput, title: rawName });

    expect({
      label: getToolLabel(normalized.name, normalized.input),
      name: getToolName(normalized.name, normalized.input),
      summary: getToolSummary(normalized.name, normalized.input),
    }).toEqual(expected);
  });
});
