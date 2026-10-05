/** @jest-environment jsdom */
import '@/providers';

import { testDate } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { Component, Platform } from 'obsidian';

import type { ProviderExecutionEvent, ProviderSessionConfig } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { getToolIcon } from '@/core/tools/toolIcons';
import type { ChatMessage, StreamChunk, ToolCallInfo } from '@/core/types';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { providerOutputEventToStreamChunk } from '@/features/chat/rendering/providerOutputChunks';
import { renderStoredToolCall } from '@/features/chat/rendering/tools/ToolCallRenderer';
import { ChatState } from '@/features/chat/state/ChatState';
import { SubagentManager } from '@/features/chat/subagents/SubagentManager';
import { StreamController } from '@/features/chat/turns/StreamController';
import type { ACPSessionNotification } from '@/providers/acp';
import { GrokExecutionBackend, type GrokExecutionNativeConnection } from '@/providers/grok/execution/GrokExecutionBackend';
import { parseGrokHistoryContent } from '@/providers/grok/history/GrokHistoryStore';
import { updateCurrentGrokCatalog } from '@/providers/grok/settings';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
HTMLElement.prototype.toggleClass = function (names, enabled) {
  for (const name of Array.isArray(names) ? names : [names]) this.classList.toggle(name, enabled);
};
HTMLElement.prototype.scrollIntoView = function () {};
HTMLElement.prototype.setText = function (text) { this.textContent = String(text); };

beforeEach(() => document.body.replaceChildren());

const SESSION_ID = 'session-new';

/** Provider events from the most recent live replay, for assertions about streaming. */
let liveEvents: ProviderExecutionEvent[] = [];

/** Native `session/update` payloads for one tool call, as Grok 1.0.46 emits them (paths sanitized). */
type NativeToolUpdates = Array<Record<string, unknown>>;

function createGrokHost(): ProviderHost {
  const host = {
    getResolvedProviderCliPath: async () => 'grok',
    settings: { model: 'grok/grok-4', providerConfigs: { grok: { enabled: true, visibleModels: ['grok-4'] } } },
  } as unknown as ProviderHost;
  updateCurrentGrokCatalog(host.settings, {
    defaultModelId: 'grok-4', fingerprint: 'fixture', refreshedAt: 1,
    models: [{ rawId: 'grok-4', displayName: 'Grok 4', supportsReasoning: false, reasoningEfforts: [] }],
  });
  return host;
}

/** Streams the native updates through a live Grok session into the chat stream controller. */
async function restoreLive(updates: NativeToolUpdates): Promise<ToolCallInfo> {
  let notify: ((value: ACPSessionNotification, source: 'extension' | 'standard') => void) | null = null;
  const native: GrokExecutionNativeConnection = {
    cancel: () => undefined,
    initialize: async () => undefined,
    listCommands: async () => [],
    loadSession: async request => ({ sessionId: request.sessionId }),
    newSession: async () => ({ sessionId: SESSION_ID }),
    onNotification: listener => { notify = listener; return () => { notify = null; }; },
    prompt: async () => {
      for (const update of updates) {
        notify?.({ sessionId: SESSION_ID, update } as unknown as ACPSessionNotification, 'standard');
      }
      return { stopReason: 'end_turn' };
    },
    setMode: async () => undefined,
    setModel: async () => ({}),
    shutdown: async () => undefined,
  };
  const config: ProviderSessionConfig = {
    interactionPort: { askUserQuestion: jest.fn(), dismissInteraction: jest.fn(), requestApproval: jest.fn() },
    lifecycle: 'persistent',
    nativePersistence: 'enabled',
    vaultWorkingDirectory: '/workspace',
  };
  const session = new GrokExecutionBackend(createGrokHost(), { nativeFactory: { create: () => native } })
    .createSession(config);
  const output: ProviderExecutionEvent[] = [];
  try {
    for await (const event of session.execute({
      configuration: {
        model: 'grok/grok-4', permissionMode: 'normal', reasoning: null,
        systemInstructions: { kind: 'explicit', instructions: '' },
      },
      input: [{ type: 'text', text: 'run the tool' }],
      signal: new AbortController().signal,
      toolPolicy: { kind: 'provider-default' },
    }).events) output.push(event);
  } finally {
    await session.dispose();
  }
  liveEvents = output;

  const messages = document.body.createDiv();
  const state = new ChatState();
  // Vault refresh after file edits is an Obsidian boundary; this stub keeps it inert.
  const vault = { adapter: { basePath: '/workspace', list: async () => ({ files: [], folders: [] }) }, getAbstractFileByPath: () => null };
  const plugin = { app: { vault }, settings: { mediaFolder: '', showMessageTimestamps: false } } as any;
  const renderer = new MessageRenderer(plugin, new Component(), messages);
  const stream = new StreamController({ plugin, state, renderer,
    subagentManager: new SubagentManager(() => undefined), getMessagesEl: () => messages, updateQueueIndicator: () => undefined,
  });
  const response: ChatMessage = { id: 'response', role: 'assistant', timestamp: testDate().getTime(), content: '', contentBlocks: [] };
  state.addMessage(response);
  state.currentContentEl = renderer.addMessage(response).querySelector('.claudian-message-content');
  for (const chunk of output.map(providerOutputEventToStreamChunk)) {
    if (chunk?.type === 'tool_use' || chunk?.type === 'tool_output' || chunk?.type === 'tool_result') {
      await stream.handleStreamChunk(chunk as StreamChunk, response);
    }
  }
  messages.remove();
  expect(response.toolCalls).toHaveLength(1);
  return response.toolCalls![0];
}

/** Replays the same native updates from Grok's `updates.jsonl` history. */
function restoreHistory(updates: NativeToolUpdates): ToolCallInfo {
  const timestamp = Math.floor(testDate().getTime() / 1000);
  const record = (update: Record<string, unknown>) => JSON.stringify({
    method: 'session/update', params: { sessionId: SESSION_ID, update }, timestamp,
  });
  const content = [
    record({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'run the tool' } }),
    ...updates.map(record),
    record({ sessionUpdate: 'turn_completed', stop_reason: 'end_turn' }),
  ].join('\n');
  const assistant = parseGrokHistoryContent(content, SESSION_ID).messages.find(message => message.role === 'assistant');
  expect(assistant?.toolCalls).toHaveLength(1);
  return assistant!.toolCalls![0];
}

const restore = (mode: 'live' | 'history', updates: NativeToolUpdates) => mode === 'live'
  ? restoreLive(updates)
  : Promise.resolve(restoreHistory(updates));

const expand = (block: HTMLElement, name: RegExp) => {
  const header = within(block).getByRole('button', { name });
  fireEvent.keyDown(header, { key: 'Enter' });
  return header;
};

const lines = (block: HTMLElement) => [...block.querySelectorAll('.claudian-tool-line')].map(line => line.textContent);

function bashUpdates(id: string, command: string, chunks: Array<{ text: string; rawOutput: Record<string, unknown> }>, final: {
  exitCode: number; text: string; outputForPrompt: string; timedOut?: boolean; signal?: string | null;
}): NativeToolUpdates {
  const bash = (overrides: Record<string, unknown>) => ({
    type: 'Bash', output: [], output_for_prompt: '', exit_code: 0, command, truncated: false,
    signal: null, timed_out: false, description: null, current_dir: '/workspace', output_file: '', total_bytes: 0, ...overrides,
  });
  const description = `Run ${command}`;
  return [
    { sessionUpdate: 'tool_call', toolCallId: id, title: 'run_terminal_command', rawInput: { command, description },
      _meta: { 'x.ai/tool': { version: 1, name: 'run_terminal_command', kind: 'execute', namespace: 'grok_build', label: 'Run Command', read_only: false } } },
    { sessionUpdate: 'tool_call_update', toolCallId: id, kind: 'execute', title: `Execute \`${command}\``,
      content: [{ type: 'content', content: { type: 'text', text: description } }], locations: [],
      rawInput: { variant: 'Bash', command, description, is_background: false } },
    { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress',
      content: [{ type: 'content', content: { type: 'text', text: '' } }], rawOutput: bash({}) },
    ...chunks.map(chunk => ({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress',
      content: [{ type: 'content', content: { type: 'text', text: chunk.text } }], rawOutput: bash(chunk.rawOutput) })),
    { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: final.text } }],
      rawOutput: bash({ output_for_prompt: final.outputForPrompt, exit_code: final.exitCode, timed_out: final.timedOut ?? false,
        signal: final.signal ?? null, description, output_file: `/grok/terminal/${id}.log` }) },
  ];
}

function readUpdates(target: string, completion: Record<string, unknown>): NativeToolUpdates {
  return [
    { sessionUpdate: 'tool_call', toolCallId: 'read', title: 'read_file', rawInput: { target_file: target } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'read', kind: 'read', title: `Read \`${target}\``,
      locations: [{ path: target }], rawInput: { variant: 'ReadFile', target_file: target } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'read', ...completion },
  ];
}

function editUpdates(id: string, title: string, rawInput: Record<string, unknown>, completion: Record<string, unknown>): NativeToolUpdates {
  return [
    { sessionUpdate: 'tool_call', toolCallId: id, title, rawInput },
    { sessionUpdate: 'tool_call_update', toolCallId: id, ...completion },
  ];
}

function mcpLookupUpdates(): NativeToolUpdates {
  return [
    { sessionUpdate: 'tool_call', toolCallId: 'mcp', title: 'use_tool',
      rawInput: { tool_name: 'probe__lookup_note', tool_input: { title: 'Roadmap' } } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'mcp', kind: 'other', title: 'probe__lookup_note',
      rawInput: { variant: 'UseTool', tool_name: 'probe__lookup_note', tool_input: { title: 'Roadmap' } } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'mcp', status: 'completed',
      rawOutput: { type: 'MCP', tool_name: 'lookup_note', server_name: 'probe',
        output: { OkayOutput: 'Note "Roadmap": summary line one\nsummary line two' } } },
  ];
}

describe.each(['live', 'history'] as const)('%s Grok tool presentation', mode => {
  it('shows terminal output without the pre-execution description or ANSI escapes', async () => {
    const plain = 'total 16\ndrwxr-xr-x@ 4 user wheel 128 .\n-rw-r--r--@ 1 user wheel 32 notes.txt\n  0%100% done\n';
    const colored = 'total 16\ndrwxr-xr-x@ 4 user wheel 128 \u001b[34m.\u001b[39;49m\u001b[0m\n-rw-r--r--@ 1 user wheel 32 notes.txt\n\r  0%\r100% done\n';
    const tool = await restore(mode, bashUpdates('bash-ok', 'ls -la', [
      { text: colored, rawOutput: { output_for_prompt: plain, total_bytes: 90 } },
    ], { exitCode: 0, text: colored, outputForPrompt: `exit: 0\n${plain}` }));

    expect(tool).toMatchObject({ name: 'Bash', status: 'completed' });
    expect(getToolIcon(tool.name)).toBe(getToolIcon('Bash'));
    const block = renderStoredToolCall(document.body.createDiv(), tool);
    expand(block, /^Bash: ls -la/);
    expect(block.querySelector('.claudian-tool-bash-command')?.textContent).toBe('$ ls -la');
    expect(lines(block)).toEqual([
      'total 16',
      'drwxr-xr-x@ 4 user wheel 128 .',
      '-rw-r--r--@ 1 user wheel 32 notes.txt',
      '100% done',
    ]);
    expect((await axe(block)).violations).toEqual([]);
  });

  it.each([
    [{ exitCode: 3 }, 'exit: 3'],
    [{ exitCode: 0, timedOut: true }, 'timed out'],
    [{ exitCode: 0, signal: 'SIGKILL' }, 'signal: SIGKILL'],
  ])('marks completed terminal commands that failed natively as errors %#', async (termination, marker) => {
    const tool = await restore(mode, bashUpdates('bash-fail', "sh -c 'echo boom >&2; exit 3'", [
      { text: 'boom\n', rawOutput: { output_for_prompt: 'boom\n', total_bytes: 5 } },
    ], { ...termination, text: 'boom\n', outputForPrompt: 'exit: 3\nboom\n' }));

    expect(tool).toMatchObject({ name: 'Bash', status: 'error' });
    const block = renderStoredToolCall(document.body.createDiv(), tool);
    expand(block, /^Bash: sh -c/);
    expect(lines(block)).toEqual([marker, 'boom']);
  });

  it('keeps native read failures as errors with their message', async () => {
    const message = 'Error: /workspace/missing-file.txt does not exist.';
    const tool = await restore(mode, readUpdates('missing-file.txt', {
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: message } }],
      rawOutput: { type: 'ReadFile', FileNotFound: message },
    }));

    expect(tool).toMatchObject({ name: 'Read', status: 'error', result: message });
  });

  it('builds edit diffs at native line numbers with surrounding context', async () => {
    const detail = { old_string: 'beta', old_line: 2, new_string: 'BETA', new_line: 2,
      context_before: 'alpha\n', context_after: 'gamma\n-- sql comment\n', line_prefix: '' };
    const tool = await restore(mode, editUpdates('edit', 'search_replace', { file_path: 'notes.txt', old_string: 'beta', new_string: 'BETA' }, {
      status: 'completed',
      content: [{ type: 'diff', path: '/workspace/notes.txt', oldText: 'beta', newText: 'BETA', _meta: { details: [detail] } }],
      rawOutput: { type: 'SearchReplace', EditsApplied: {
        old_string: 'beta', new_string: 'BETA', tool_output_for_prompt: 'The file notes.txt has been updated successfully.',
        tool_output_for_prompt_concise: 'The file notes.txt has been updated.', absolute_path: '/workspace/notes.txt',
        edits: { details: [detail] },
      } },
    }));

    expect(tool).toMatchObject({ name: 'Edit', status: 'completed' });
    expect(tool.diffData?.stats).toEqual({ added: 1, removed: 1 });
    expect(tool.diffData?.diffLines).toEqual([
      { type: 'equal', text: 'alpha', oldLineNum: 1, newLineNum: 1 },
      { type: 'delete', text: 'beta', oldLineNum: 2 },
      { type: 'insert', text: 'BETA', newLineNum: 2 },
      { type: 'equal', text: 'gamma', oldLineNum: 3, newLineNum: 3 },
      { type: 'equal', text: '-- sql comment', oldLineNum: 4, newLineNum: 4 },
    ]);
  });

  it('builds new-file diffs from native write results', async () => {
    const detail = { old_string: '', old_line: 1, new_string: 'first\nsecond', new_line: 1,
      context_before: '', context_after: '', line_prefix: '' };
    const tool = await restore(mode, editUpdates('write', 'write', { file_path: 'created.md', content: 'first\nsecond' }, {
      status: 'completed',
      content: [{ type: 'diff', path: '/workspace/created.md', oldText: '', newText: 'first\nsecond', _meta: { details: [detail] } }],
      rawOutput: { type: 'SearchReplace', EditsApplied: {
        old_string: '', new_string: 'first\nsecond', tool_output_for_prompt: 'The file /workspace/created.md has been created.',
        tool_output_for_prompt_concise: 'The file /workspace/created.md has been created.', absolute_path: '/workspace/created.md',
        edits: { details: [detail] },
      } },
    }));

    expect(tool).toMatchObject({ name: 'Write', status: 'completed' });
    expect(tool.diffData?.diffLines).toEqual([
      { type: 'insert', text: 'first', newLineNum: 1 },
      { type: 'insert', text: 'second', newLineNum: 2 },
    ]);
  });

  it('keeps unmatched edits as errors with the native message', async () => {
    const message = 'The string to replace was not found in the file, use the read_file tool to see the correct string.';
    const tool = await restore(mode, editUpdates('edit-miss', 'search_replace', { file_path: 'notes.txt', old_string: 'missing', new_string: 'x' }, {
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: message } }],
      rawOutput: { type: 'SearchReplace', NoMatchesFound: { message, file_path: '/workspace/notes.txt' } },
    }));

    expect(tool).toMatchObject({ name: 'Edit', status: 'error', result: message });
    expect(tool.diffData).toBeUndefined();
  });

  it('lists grep matches as path, line, and content', async () => {
    const tool = await restore(mode, editUpdates('grep', 'grep', { pattern: 'alpha', path: '.' }, {
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'found 2 matches' } }],
      rawOutput: { type: 'GrepSearch', stdout: [60, 119], stderr: [], exit_code: 0, match_count: 2, file_matches: [
        { path: '/workspace/./notes.txt', matches: [{ line_number: 1, content: 'alpha' }, { line_number: 5, content: 'alpha beta' }] },
      ] },
    }));

    expect(tool).toMatchObject({ name: 'Grep', status: 'completed' });
    const block = renderStoredToolCall(document.body.createDiv(), tool);
    expand(block, /^Grep: alpha/);
    expect(lines(block)).toEqual(['/workspace/notes.txt:1:alpha', '/workspace/notes.txt:5:alpha beta']);
  });

  it('shows directory listings carried only in the native output', async () => {
    const tool = await restore(mode, editUpdates('ls', 'list_dir', { target_directory: '.' }, {
      status: 'completed',
      rawOutput: { type: 'ListDir', Content: { content: '- /workspace/\n  - created.md\n  - notes.txt', absolute_root_path: '/workspace/.' } },
    }));

    expect(tool).toMatchObject({ name: 'LS', status: 'completed' });
    const block = renderStoredToolCall(document.body.createDiv(), tool);
    expand(block, /^LS: \./);
    expect(lines(block)).toEqual(['- /workspace/', '  - created.md', '  - notes.txt']);
  });

  it('shows native error variants that carry no content', async () => {
    const message = 'Error: /workspace/missing-dir does not exist.';
    const tool = await restore(mode, editUpdates('ls-missing', 'list_dir', { target_directory: './missing-dir' }, {
      status: 'failed',
      rawOutput: { type: 'ListDir', NotFound: message },
    }));

    expect(tool).toMatchObject({ name: 'LS', status: 'error', result: message });
  });

  it('renders web search citations as links without the synthesized answer', async () => {
    const answer = 'The Obsidian Plugin API lets you extend Obsidian.[[1]](https://github.com/obsidianmd/obsidian-api)';
    const tool = await restore(mode, editUpdates('search', 'web_search', { query: 'Obsidian plugin API' }, {
      status: 'completed',
      rawOutput: { type: 'WebSearch', query: 'Obsidian plugin API', content: answer, allowed_domains: null,
        citations: ['https://github.com/obsidianmd/obsidian-api', 'https://docs.obsidian.md/'] },
    }));

    expect(tool).toMatchObject({ name: 'WebSearch', status: 'completed' });
    const block = renderStoredToolCall(document.body.createDiv(), tool);
    expand(block, /Obsidian plugin API/);
    expect(within(block).getByRole('link', { name: 'https://github.com/obsidianmd/obsidian-api' }).getAttribute('href'))
      .toBe('https://github.com/obsidianmd/obsidian-api');
    expect(within(block).getByRole('link', { name: 'https://docs.obsidian.md/' })).toBeDefined();
    expect(block.textContent).not.toContain('lets you extend Obsidian');
    expect((await axe(block)).violations).toEqual([]);
  });

  it('renders MCP calls made through use_tool under the MCP tool name', async () => {
    const tool = await restore(mode, mcpLookupUpdates());

    expect(tool).toMatchObject({ name: 'mcp__probe__lookup_note', input: { title: 'Roadmap' }, status: 'completed' });
    expect(tool.providerPayload).toMatchObject({ rawName: 'use_tool' });
    expect(getToolIcon(tool.name)).toBe(getToolIcon('mcp__server__tool'));
    const block = renderStoredToolCall(document.body.createDiv(), tool);
    expand(block, /^mcp__probe__lookup_note/);
    expect(lines(block)).toEqual(['Note "Roadmap": summary line one', 'summary line two']);
  });

  it('keeps failed MCP calls as errors with the server message', async () => {
    const tool = await restore(mode, [
      { sessionUpdate: 'tool_call', toolCallId: 'mcp-fail', title: 'use_tool',
        rawInput: { tool_name: 'probe__broken_tool', tool_input: { reason: 'testing' } } },
      { sessionUpdate: 'tool_call_update', toolCallId: 'mcp-fail', status: 'failed',
        rawOutput: { type: 'MCP', tool_name: 'broken_tool', server_name: 'probe',
          output: { Error: 'broken_tool failed: testing' }, is_error: true } },
    ]);

    expect(tool).toMatchObject({ name: 'mcp__probe__broken_tool', status: 'error', result: 'broken_tool failed: testing' });
  });

  it('lists tools found by search_tool', async () => {
    const catalog = { results: [{ server: 'probe', tools: [
      { tool_name: 'probe__broken_tool', description: 'Always fails.', score: 0.26, input_schema: { type: 'object' } },
      { tool_name: 'probe__lookup_note', description: 'Look up a note by title.\nSecond line.', score: 0.24, input_schema: { type: 'object' } },
    ] }], total_hidden_tools: 2, status: 'ready', note: null };
    const text = JSON.stringify(catalog, null, 2);
    const tool = await restore(mode, editUpdates('search-tool', 'search_tool', { query: 'probe' }, {
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text } }],
      rawOutput: { type: 'SearchTool', result_count: 2, content: text },
    }));

    expect(tool).toMatchObject({ name: 'ToolSearch', status: 'completed' });
    const block = renderStoredToolCall(document.body.createDiv(), tool);
    expand(block, /^ToolSearch: probe/);
    expect(lines(block)).toEqual(['probe__broken_tool — Always fails.', 'probe__lookup_note — Look up a note by title.']);
  });

  it('renders workflow launches as a Rhai script with the native launch message', async () => {
    const script = 'let meta = #{ name: "pong", description: "tiny pong workflow" };\nagent("Reply with pong.")';
    const message = "Workflow 'pong' started in the background.";
    const tool = await restore(mode, editUpdates('workflow', 'workflow', { source: { script, type: 'script' }, agent_budget: 1 }, {
      status: 'completed',
      rawOutput: { type: 'Workflow', run_id: 'wf_1', task_id: 'wf_1', name: 'pong', script_path: '/grok/workflows/wf_1/script.rhai', message },
    }));

    expect(tool).toMatchObject({ name: 'Workflow', status: 'completed', result: message });
    expect(getToolIcon(tool.name)).toBe('workflow');
    const block = renderStoredToolCall(document.body.createDiv(), tool);
    expand(block, /^Workflow: pong/);
    expect([...block.querySelectorAll('.claudian-tool-script-label')].map(label => label.textContent)).toEqual(['Rhai', 'Output']);
    expect(block.querySelector('code')?.textContent).toBe(script);
    expect(block.querySelector('.claudian-tool-script-output')?.textContent).toBe(message);
    expect((await axe(block)).violations).toEqual([]);
  });

  it('shows background shell output fetched by task id as the shell output', async () => {
    const taskId = '01a0f86a-7a6c-7170-aee5-24cfd460e4ff';
    const tool = await restore(mode, [
      { sessionUpdate: 'tool_call', toolCallId: 'wait', title: 'get_command_or_subagent_output', rawInput: { task_ids: [taskId], timeout_ms: 10000 } },
      { sessionUpdate: 'tool_call_update', toolCallId: 'wait', kind: 'other', title: `Get task output: ${taskId}`,
        rawInput: { variant: 'TaskOutput', task_ids: [taskId], timeout_ms: 10000 } },
      { sessionUpdate: 'tool_call_update', toolCallId: 'wait', status: 'completed', title: 'sleep 2; echo finished (01a0f86a)',
        rawOutput: { type: 'TaskOutput', Result: { task_id: taskId, command: 'sleep 2; echo finished', status: 'completed', exit_code: 3,
          duration_secs: 2.1, output: 'finished\n', output_file: '/grok/terminal/bg.log', truncated: false } } },
    ]);

    expect(tool).toMatchObject({ name: 'BashOutput', status: 'completed' });
    expect(tool.providerPayload).toMatchObject({ rawName: 'get_command_or_subagent_output' });
    expect(getToolIcon(tool.name)).toBe(getToolIcon('Bash'));
    const block = renderStoredToolCall(document.body.createDiv(), tool);
    expand(block, /^BashOutput: sleep 2; echo finished/);
    expect(block.querySelector('.claudian-tool-bash-command')?.textContent).toBe('$ sleep 2; echo finished');
    expect(lines(block)).toEqual(['exit: 3', 'finished']);
  });

  it('labels every batched shell result with its command and task identity', async () => {
    const results = [
      { task_id: 'task-first', command: 'echo first', status: 'completed', exit_code: 0, output: 'first\n' },
      { task_id: 'task-second', command: 'echo second', status: 'completed', exit_code: 3, output: 'second\n' },
    ];
    const tool = await restore(mode, editUpdates('wait-batch', 'get_command_or_subagent_output', {
      task_ids: ['task-first', 'task-second'], timeout_ms: 10000,
    }, { status: 'completed', rawOutput: { type: 'TaskOutput', Result: results } }));

    expect(tool).toMatchObject({ name: 'BashOutput', status: 'completed' });
    expect(tool.providerPayload?.rawOutput).toEqual({ type: 'TaskOutput', Result: results });
    const block = renderStoredToolCall(document.body.createDiv(), tool);
    expand(block, /^BashOutput/);
    expect(lines(block)).toEqual([
      '$ echo first (task-first)', 'first', ' ', '$ echo second (task-second)', 'exit: 3', 'second',
    ]);
  });

  it('shows the native outcome when a background task is killed', async () => {
    const tool = await restore(mode, editUpdates('kill', 'kill_command_or_subagent', { task_id: 'task-1' }, {
      status: 'completed',
      rawOutput: { type: 'KillTask', Result: { task_id: 'task-1', outcome: 'killed', message: 'Task was terminated successfully' } },
    }));

    expect(tool).toMatchObject({ name: 'kill_command_or_subagent', status: 'completed', result: 'Task was terminated successfully' });
  });

  it('keeps file text that only looks like a native read anchor', async () => {
    const text = ['1→alpha', '2→ literal arrow', ...Array.from({ length: 7 }, (_, index) => `line ${index + 3}`), '10→tenth'].join('\n');
    const tool = await restore(mode, readUpdates('notes.txt', {
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text } }],
      rawOutput: { type: 'ReadFile', FileContent: { content: text, absolute_path: '/workspace/notes.txt', offset: null, total_lines: 10 } },
    }));

    expect(tool.result).toBe(['alpha', '2→ literal arrow', ...Array.from({ length: 7 }, (_, index) => `line ${index + 3}`), 'tenth'].join('\n'));
    const block = renderStoredToolCall(document.body.createDiv(), tool);
    expand(block, /^Read: notes\.txt/);
    expect(lines(block)).toEqual(['alpha', '2→ literal arrow', ...Array.from({ length: 7 }, (_, index) => `line ${index + 3}`), 'tenth']);
  });

  it('keeps a literal leading anchor in file text', async () => {
    const text = '1→1→literal\n';
    const tool = await restore(mode, readUpdates('literal.txt', {
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text } }],
      rawOutput: { type: 'ReadFile', FileContent: { content: text, absolute_path: '/workspace/literal.txt', offset: null, total_lines: 2 } },
    }));

    const block = renderStoredToolCall(document.body.createDiv(), tool);
    expand(block, /^Read: literal\.txt/);
    expect(lines(block)?.[0]).toBe('1→literal');
  });

  it('previews generated images from their native file path', async () => {
    const path = '/grok/sessions/%2Fworkspace/s1/images/1.jpg';
    const prompt = 'a tiny simple image of a red circle on white';
    const tool = await restore(mode, editUpdates('image', 'image_gen', { prompt, aspect_ratio: '1:1' }, {
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: JSON.stringify({ path, filename: '1.jpg', session_folder: 'images',
        message: `Image generated and saved to ${path}. Do not read or re-display it.` }) } }],
      rawOutput: { type: 'ImageGen', path, filename: '1.jpg', session_folder: 'images' },
    }));

    expect(tool).toMatchObject({ name: 'GenerateImage', status: 'completed', result: path });
    expect(getToolIcon(tool.name)).toBe('image');
    const block = renderStoredToolCall(document.body.createDiv(), tool);
    expand(block, /^GenerateImage: a tiny simple image/);
    const image = within(block).getByRole('img', { name: '1.jpg' });
    expect(image.getAttribute('src')).toBe(`${Platform.resourcePathPrefix}grok/sessions/%252Fworkspace/s1/images/1.jpg`);
    expect((await axe(block)).violations).toEqual([]);
  });

  it('shows MCP image blocks that Grok inlines as data URIs', async () => {
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==';
    const tool = await restore(mode, [
      { sessionUpdate: 'tool_call', toolCallId: 'rich', title: 'use_tool', rawInput: { tool_name: 'probe__rich_result', tool_input: { label: 'demo' } } },
      { sessionUpdate: 'tool_call_update', toolCallId: 'rich', status: 'completed', rawOutput: { type: 'MCP', tool_name: 'rich_result', server_name: 'probe',
        output: { OkayOutput: `Rich result for demo\ndata:image/png;base64,${data}\n{"label":"demo","count":3}` } } },
    ]);

    expect(tool.result).toBe('Rich result for demo\n{"label":"demo","count":3}');
    const block = renderStoredToolCall(document.body.createDiv(), tool);
    expand(block, /^mcp__probe__rich_result/);
    expect(within(block).getByRole('img', { name: 'image/png' }).getAttribute('src')).toBe(`data:image/png;base64,${data}`);
  });

  it('shows image-only MCP results without the encoded payload', async () => {
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==';
    const tool = await restore(mode, [
      { sessionUpdate: 'tool_call', toolCallId: 'image-only', title: 'use_tool', rawInput: { tool_name: 'probe__snapshot', tool_input: {} } },
      { sessionUpdate: 'tool_call_update', toolCallId: 'image-only', status: 'completed', rawOutput: { type: 'MCP', tool_name: 'snapshot', server_name: 'probe',
        output: { OkayOutput: `data:image/png;base64,${data}` } } },
    ]);

    const block = renderStoredToolCall(document.body.createDiv(), tool);
    expand(block, /^mcp__probe__snapshot/);
    expect(within(block).getByRole('img', { name: 'image/png' }).getAttribute('src')).toBe(`data:image/png;base64,${data}`);
    expect(block.textContent).not.toContain(data);
    expect(within(block).queryByText('No result')).toBeNull();
  });

  it('keeps a backgrounded command completed when its task reports later output', async () => {
    const summary = 'Background task task-1 started';
    const tool = await restore(mode, [
      { sessionUpdate: 'tool_call', toolCallId: 'bg', title: 'run_terminal_command', rawInput: { command: 'echo bg', block_until_ms: 0 } },
      { sessionUpdate: 'tool_call_update', toolCallId: 'bg', status: 'completed', title: '[bg] echo bg (task-1)',
        content: [{ type: 'content', content: { type: 'text', text: summary } }],
        rawOutput: { type: 'BackgroundTaskStarted', task_id: 'task-1', task_type: 'bash', status: 'running', command: 'echo bg', summary } },
      { sessionUpdate: 'tool_call_update', toolCallId: 'bg', status: 'in_progress',
        content: [{ type: 'content', content: { type: 'text', text: 'bg\n' } }],
        rawOutput: { type: 'Bash', output: [98, 103, 10], output_for_prompt: 'bg\n', exit_code: 0, command: 'echo bg' } },
    ]);

    expect(tool).toMatchObject({ name: 'Bash', status: 'completed', result: summary });
  });
});

describe('live Grok event contracts', () => {
  it('retains MCP arguments on every tool-start update', async () => {
    await restoreLive(mcpLookupUpdates());
    const starts = liveEvents.filter(event => event.type === 'tool_started' && event.toolCallId === 'mcp');
    expect(starts.length).toBeGreaterThan(1);
    expect(starts).toEqual(starts.map(() => expect.objectContaining({ input: { title: 'Roadmap' } })));
  });

  it('streams completed terminal lines while progress rewrites the current line', async () => {
    const tool = await restoreLive(bashUpdates('progress', 'curl -I https://example.com', [
      { text: 'header\r  0%', rawOutput: {} },
      { text: 'header\r  0%\r 50%', rawOutput: {} },
      { text: 'header\r  0%\r 50%\r100%\nHTTP/2 200\n', rawOutput: {} },
    ], { exitCode: 0, text: 'header\r  0%\r 50%\r100%\nHTTP/2 200\n', outputForPrompt: 'exit: 0\n100%\nHTTP/2 200\n' }));

    const streamed = liveEvents.flatMap(event => (
      event.type === 'tool_output' && event.toolCallId === 'progress' ? [event.content] : []
    ));
    expect(streamed.join('')).toBe('100%\nHTTP/2 200\n');
    expect(tool.result).toBe('100%\nHTTP/2 200');
  });
});
