import {
  isCodexToolOutputError,
  normalizeCodexMcpToolInput,
  normalizeCodexMcpToolName,
  normalizeCodexMcpToolState,
  normalizeCodexToolInput,
  normalizeCodexToolName,
  normalizeCodexToolResult,
  parseCodexArguments,
} from '@/providers/codex/normalization/codexToolNormalization';

describe('normalizeCodexToolName', () => {
  it.each([
    ['command_execution', 'Bash'],
    ['shell_command', 'Bash'],
    ['exec_command', 'Bash'],
    ['update_plan', 'TodoWrite'],
    ['request_user_input', 'AskUserQuestion'],
    ['view_image', 'Read'],
    ['web_search', 'WebSearch'],
    ['web_search_call', 'WebSearch'],
    ['file_change', 'apply_patch'],
  ])('maps %s to %s', (raw, expected) => {
    expect(normalizeCodexToolName(raw)).toBe(expected);
  });

  it.each([
    'apply_patch',
    'write_stdin',
    'spawn_agent',
    'send_input',
    'wait',
    'wait_agent',
    'resume_agent',
    'close_agent',
  ])('preserves native tool %s', (name) => {
    expect(normalizeCodexToolName(name)).toBe(name);
  });

  it('passes through unknown tool names', () => {
    expect(normalizeCodexToolName('custom_tool')).toBe('custom_tool');
  });

  it('returns "tool" for undefined', () => {
    expect(normalizeCodexToolName(undefined)).toBe('tool');
  });
});

describe('normalizeCodexToolInput', () => {
  it('normalizes exec_command to { command }', () => {
    const result = normalizeCodexToolInput('exec_command', { command: 'ls -la' });
    expect(result).toEqual({ command: 'ls -la' });
  });

  it('normalizes shell_command with cmd to { command }', () => {
    const result = normalizeCodexToolInput('shell_command', { cmd: 'pwd' });
    expect(result).toEqual({ command: 'pwd' });
  });

  it('normalizes update_plan to TodoWrite-compatible todos', () => {
    const result = normalizeCodexToolInput('update_plan', {
      plan: [
        { id: '1', title: 'Fix bug', status: 'completed' },
        { id: '2', title: 'Run tests', status: 'in_progress' },
      ],
    });

    expect(result.todos).toEqual([
      { id: '1', content: 'Fix bug', activeForm: 'Fix bug', status: 'completed' },
      { id: '2', content: 'Run tests', activeForm: 'Run tests', status: 'in_progress' },
    ]);
  });

  it('normalizes update_plan with step field (real Codex format)', () => {
    const result = normalizeCodexToolInput('update_plan', {
      plan: [
        { step: 'Gather requirements', status: 'in_progress' },
        { step: 'Write code', status: 'pending' },
        { step: 'Deploy', status: 'pending' },
      ],
    });

    expect(result.todos).toEqual([
      { id: '', content: 'Gather requirements', activeForm: 'Gather requirements', status: 'in_progress' },
      { id: '', content: 'Write code', activeForm: 'Write code', status: 'pending' },
      { id: '', content: 'Deploy', activeForm: 'Deploy', status: 'pending' },
    ]);
  });

  it('normalizes request_user_input questions', () => {
    const result = normalizeCodexToolInput('request_user_input', {
      questions: [{
        question: 'Update tests?',
        id: 'q1',
        options: [
          { label: 'Yes', description: 'Update tests too' },
          { label: 'No', description: 'Leave tests alone' },
        ],
        multi_select: true,
      }],
    });

    expect(result.questions).toEqual([
      {
        question: 'Update tests?',
        id: 'q1',
        header: 'Q1',
        options: [
          { label: 'Yes', description: 'Update tests too' },
          { label: 'No', description: 'Leave tests alone' },
        ],
        multiSelect: true,
      },
    ]);
  });

  it('normalizes shell command arrays into a single command string', () => {
    const result = normalizeCodexToolInput('shell', {
      command: ['bash', '-lc', 'git log -1 --stat'],
    });
    expect(result).toEqual({ command: 'bash -lc git log -1 --stat' });
  });

  it('normalizes view_image path to file_path', () => {
    const result = normalizeCodexToolInput('view_image', { path: '/tmp/img.png' });
    expect(result.file_path).toBe('/tmp/img.png');
  });

  it('normalizes web_search_call with action.query', () => {
    const result = normalizeCodexToolInput('web_search_call', {
      action: { query: 'obsidian api' },
    });
    expect(result).toEqual({ actionType: 'search', query: 'obsidian api' });
  });

  it('normalizes web_search with query', () => {
    const result = normalizeCodexToolInput('web_search', { query: 'test' });
    expect(result).toEqual({ actionType: 'search', query: 'test' });
  });

  it('normalizes web_search_call open_page actions', () => {
    const result = normalizeCodexToolInput('web_search_call', {
      action: { type: 'open_page', url: 'https://example.com/docs' },
    });
    expect(result).toEqual({ actionType: 'open_page', url: 'https://example.com/docs' });
  });

  it('normalizes web_search_call find_in_page actions', () => {
    const result = normalizeCodexToolInput('web_search_call', {
      action: {
        type: 'find_in_page',
        url: 'https://example.com/docs',
        pattern: 'tools',
      },
    });
    expect(result).toEqual({
      actionType: 'find_in_page',
      url: 'https://example.com/docs',
      pattern: 'tools',
    });
  });

  it('deduplicates web_search queries and preserves the primary query', () => {
    const result = normalizeCodexToolInput('web_search_call', {
      action: {
        type: 'search',
        query: 'obsidian plugin API',
        queries: ['obsidian plugin API', 'obsidian plugin API', 'obsidian docs'],
      },
    });
    expect(result).toEqual({
      actionType: 'search',
      query: 'obsidian plugin API',
      queries: ['obsidian plugin API', 'obsidian docs'],
    });
  });

  it('preserves apply_patch input', () => {
    const input = { patch: '*** Update File: foo.ts\n...', changes: [{ path: 'foo.ts', kind: 'update' }] };
    const result = normalizeCodexToolInput('apply_patch', input);
    expect(result).toEqual(input);
  });

  it('normalizes raw apply_patch input into patch text', () => {
    const result = normalizeCodexToolInput('apply_patch', {
      raw: '*** Begin Patch\n*** Update File: foo.ts\n*** End Patch',
    });
    expect(result).toEqual({
      patch: '*** Begin Patch\n*** Update File: foo.ts\n*** End Patch',
    });
  });

  it('preserves spawn_agent input', () => {
    const input = { message: 'Do something', agent_type: 'code-writer' };
    const result = normalizeCodexToolInput('spawn_agent', input);
    expect(result).toEqual(input);
  });
});

describe('Codex MCP normalization helpers', () => {
  it('normalizes MCP tool names', () => {
    expect(normalizeCodexMcpToolName('filesystem', 'read_file')).toBe('mcp__filesystem__read_file');
  });

  it('normalizes MCP arguments from string and object inputs', () => {
    expect(normalizeCodexMcpToolInput('{"path":"README.md"}')).toEqual({ path: 'README.md' });
    expect(normalizeCodexMcpToolInput({ path: 'README.md' })).toEqual({ path: 'README.md' });
  });

  it('normalizes MCP completed state with structured text results', () => {
    expect(normalizeCodexMcpToolState(
      'completed',
      { content: [{ text: 'line 1' }, { text: 'line 2' }] },
      undefined,
    )).toEqual({
      isTerminal: true,
      isError: false,
      status: 'completed',
      result: 'line 1\nline 2',
    });
  });

  it('normalizes MCP failed state with error text', () => {
    expect(normalizeCodexMcpToolState(
      'failed',
      undefined,
      'Permission denied',
    )).toEqual({
      isTerminal: true,
      isError: true,
      status: 'error',
      result: 'Permission denied',
    });
  });
});

describe('normalizeCodexToolResult', () => {
  it('unwraps JSON { output: "..." } for Bash', () => {
    const result = normalizeCodexToolResult('Bash', '{"output":"hello world"}');
    expect(result).toBe('hello world');
  });

  it('strips Output:\\n prefix for Bash', () => {
    const result = normalizeCodexToolResult('Bash', 'Exit code: 0\nOutput:\nfile.txt');
    expect(result).toBe('file.txt');
  });

  it('unwraps JSON and then strips Output prefix', () => {
    const result = normalizeCodexToolResult('Bash', '{"output":"Exit code: 0\\nOutput:\\nresult"}');
    expect(result).toBe('result');
  });

  it('does not modify non-terminal tool results', () => {
    const result = normalizeCodexToolResult('apply_patch', '{"output":"something"}');
    expect(result).toBe('{"output":"something"}');
  });

  it('normalizes write_stdin results', () => {
    const result = normalizeCodexToolResult('write_stdin', '{"output":"done"}');
    expect(result).toBe('done');
  });

  it('passes through empty strings', () => {
    expect(normalizeCodexToolResult('Bash', '')).toBe('');
  });
});

describe('isCodexToolOutputError', () => {
  it('detects non-zero exit code', () => {
    expect(isCodexToolOutputError('Exit code: 1\nOutput:\nerror')).toBe(true);
  });

  it('detects "Process exited with code" format', () => {
    expect(isCodexToolOutputError('Process exited with code 127')).toBe(true);
  });

  it('returns false for exit code 0', () => {
    expect(isCodexToolOutputError('Exit code: 0\nOutput:\nok')).toBe(false);
  });

  it('returns false when no exit code pattern', () => {
    expect(isCodexToolOutputError('Search complete')).toBe(false);
  });

  it('detects Error: prefix', () => {
    expect(isCodexToolOutputError('Error: permission denied')).toBe(true);
  });

  it('detects lowercase error: prefix', () => {
    expect(isCodexToolOutputError('error: file not found')).toBe(true);
  });

  it('detects JSON error wrapper', () => {
    expect(isCodexToolOutputError('{"error":"not found"}')).toBe(true);
  });

  it('does not false-positive on normal output mentioning error', () => {
    expect(isCodexToolOutputError('Fixed the error in line 5')).toBe(false);
  });

  it('does not false-positive on exit code 0', () => {
    expect(isCodexToolOutputError('Exit code: 0\nOutput:\nall good')).toBe(false);
  });
});

describe('parseCodexArguments', () => {
  it('parses valid JSON object', () => {
    expect(parseCodexArguments('{"command":"ls"}')).toEqual({ command: 'ls' });
  });

  it('wraps non-object JSON', () => {
    expect(parseCodexArguments('"hello"')).toEqual({ value: 'hello' });
  });

  it('wraps unparseable string', () => {
    expect(parseCodexArguments('not json')).toEqual({ raw: 'not json' });
  });

  it('returns empty object for undefined', () => {
    expect(parseCodexArguments(undefined)).toEqual({});
  });
});
