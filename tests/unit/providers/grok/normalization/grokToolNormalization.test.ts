import {
  normalizeGrokToolCall,
  normalizeGrokToolName,
  resolveGrokRawToolName,
} from '@/providers/grok/normalization/grokToolNormalization';

describe('grokToolNormalization', () => {
  it.each([
    ['run_terminal_command', 'Bash'],
    ['get_terminal_command_output', 'BashOutput'],
    ['kill_terminal_command', 'KillShell'],
    ['read_file', 'Read'],
    ['hashline_read', 'Read'],
    ['write', 'Write'],
    ['write_file', 'Write'],
    ['search_replace', 'Edit'],
    ['hashline_edit', 'Edit'],
    ['edit_notebook', 'NotebookEdit'],
    ['apply_patch', 'apply_patch'],
    ['list_dir', 'LS'],
    ['grep', 'Grep'],
    ['hashline_grep', 'Grep'],
    ['todo_write', 'TodoWrite'],
    ['web_search', 'WebSearch'],
    ['web_fetch', 'WebFetch'],
    ['ask_user_question', 'AskUserQuestion'],
    ['skill', 'Skill'],
    ['search_tool', 'ToolSearch'],
  ])('maps %s to the approved renderer %s', (rawName, expected) => {
    expect(normalizeGrokToolName(rawName)).toBe(expected);
  });

  it.each([
    'task',
    'task_output',
    'wait_for_task',
    'kill_task',
    'spawn_subagent',
    'get_command_or_subagent_output',
    'kill_command_or_subagent',
  ])(
    'keeps task-family tool %s ordinary and raw',
    (rawName) => {
      expect(normalizeGrokToolName(rawName)).toBe(rawName);
    },
  );

  it.each([
    'spawn_subagent',
    'get_command_or_subagent_output',
    'kill_command_or_subagent',
  ])('keeps observed dynamic task title %s ordinary and lossless', (rawName) => {
    expect(normalizeGrokToolName(rawName)).toBe(rawName);
  });

  it('preserves unknown names and raw input/output losslessly', () => {
    const rawInput = { nested: { flag: true }, value: 7 };
    const rawOutput = { extra: ['a', 'b'], result: 'ok' };

    expect(normalizeGrokToolCall({
      rawInput,
      rawOutput,
      title: 'future_xai_tool',
    })).toEqual({
      input: rawInput,
      name: 'future_xai_tool',
      output: JSON.stringify(rawOutput),
      rawInput,
      rawName: 'future_xai_tool',
      rawOutput,
    });
  });

  it.each([
    ['read_file', { target_file: 'notes/readme.md' }, { file_path: 'notes/readme.md' }],
    ['hashline_read', { target_file: 'notes/readme.md' }, { file_path: 'notes/readme.md' }],
    ['list_dir', { target_directory: 'src/providers' }, { path: 'src/providers' }],
    ['skill', { name: 'commit' }, { skill: 'commit' }],
  ])('adapts %s input to its renderer contract', (rawName, rawInput, expected) => {
    const normalized = normalizeGrokToolCall({ rawInput, title: rawName });

    expect(normalized.input).toEqual(expect.objectContaining({
      ...rawInput,
      ...expected,
    }));
    expect(normalized.rawInput).toBe(rawInput);
  });

  it('adds renderer todo fields without mutating the provider payload', () => {
    const rawInput = {
      merge: false,
      todos: [{ content: 'Run tests', id: 'test', status: 'in_progress' }],
    };

    const normalized = normalizeGrokToolCall({ rawInput, title: 'todo_write' });

    expect(normalized.input.todos).toEqual([{
      activeForm: 'Run tests',
      content: 'Run tests',
      id: 'test',
      status: 'in_progress',
    }]);
    expect(normalized.rawInput).toBe(rawInput);
    expect(rawInput.todos[0]).not.toHaveProperty('activeForm');
  });

  it('aliases the observed Grok background flag for the subagent renderer', () => {
    const rawInput = { background: true, description: 'Inspect tools' };

    const normalized = normalizeGrokToolCall({ rawInput, title: 'spawn_subagent' });

    expect(normalized.input).toEqual({
      background: true,
      description: 'Inspect tools',
      run_in_background: true,
    });
    expect(normalized.rawInput).toBe(rawInput);
  });

  it('retains the raw tool name when later titles become presentation text', () => {
    expect(resolveGrokRawToolName({ provenance: 'title', rawName: 'run_terminal_command' }, {
      title: 'Execute the verification command',
    })).toEqual({ provenance: 'title', rawName: 'run_terminal_command' });
    expect(resolveGrokRawToolName(undefined, { kind: 'read', title: 'read_file' }))
      .toEqual({ provenance: 'title', rawName: 'read_file' });
  });

  it('replaces a kind fallback with late unknown titles and retains their provenance', () => {
    const kindFallback = resolveGrokRawToolName(undefined, { kind: 'execute' });
    expect(kindFallback).toEqual({ provenance: 'kind', rawName: 'execute' });

    const firstTitle = resolveGrokRawToolName(kindFallback, { title: 'future_tool' });
    expect(firstTitle).toEqual({ provenance: 'title', rawName: 'future_tool' });
    expect(resolveGrokRawToolName(firstTitle, {})).toEqual(firstTitle);
    expect(resolveGrokRawToolName(firstTitle, { title: 'future_tool_v2' })).toEqual({
      provenance: 'title',
      rawName: 'future_tool_v2',
    });
  });

  it('allows a recognized raw title update but rejects a later human presentation label', () => {
    const initial = resolveGrokRawToolName(undefined, { title: 'read_file' });
    const updated = resolveGrokRawToolName(initial, { title: 'run_terminal_command' });
    expect(updated).toEqual({ provenance: 'title', rawName: 'run_terminal_command' });
    expect(resolveGrokRawToolName(updated, {
      title: 'Execute the verification command',
    })).toEqual(updated);
  });
});
