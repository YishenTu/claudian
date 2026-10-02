/** @jest-environment jsdom */
import '@/providers';

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { testDate } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { Component } from 'obsidian';

import { getToolIcon } from '@/core/tools/toolIcons';
import type { ChatMessage, ToolCallInfo } from '@/core/types';
import { providerOutputEventToStreamChunk, StreamController } from '@/features/chat/controllers/StreamController';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { renderStoredToolCall } from '@/features/chat/rendering/ToolCallRenderer';
import { SubagentManager } from '@/features/chat/services/SubagentManager';
import { ChatState } from '@/features/chat/state/ChatState';
import { PiExecutionBackend } from '@/providers/pi/execution/PiExecutionBackend';
import { PiRPCSessionKernel } from '@/providers/pi/execution/PiExecutionKernel';
import { parsePiSessionContent } from '@/providers/pi/history/PiHistoryStore';
import { createPiEventNormalizationState, normalizePiRPCEvent } from '@/providers/pi/normalizations/piEventNormalization';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
HTMLElement.prototype.toggleClass = function (names, enabled) {
  for (const name of Array.isArray(names) ? names : [names]) this.classList.toggle(name, enabled);
};
HTMLElement.prototype.scrollIntoView = function () {};
HTMLElement.prototype.setText = function (text) { this.textContent = String(text); };

// Vault refresh after file edits is an Obsidian boundary; the listing spy observes it.
const listVaultFolder = jest.fn(async (_dir: string) => ({ files: [], folders: [] }));

beforeEach(() => {
  document.body.replaceChildren();
  listVaultFolder.mockClear();
});

/** One native Pi tool call: the model's arguments and the tool's `{ content, details }` result. */
interface NativeToolCall {
  name: string;
  args: Record<string, unknown>;
  /** Text parts of the result content. */
  text: string | string[];
  details?: Record<string, unknown>;
  isError?: boolean;
  /** Live events for calls the tool itself made; Pi never persists them as separate entries. */
  nested?: Array<Record<string, unknown>>;
}

const textParts = (call: NativeToolCall) => [call.text].flat().map(text => ({ type: 'text', text }));

/** A chat stream over a fresh assistant message, rendering into a detached message list. */
function createChatStream() {
  const messages = document.body.createDiv();
  const state = new ChatState();
  const vault = { adapter: { basePath: '/workspace', list: listVaultFolder }, getAbstractFileByPath: () => null };
  const plugin = { app: { vault }, settings: { mediaFolder: '', showMessageTimestamps: false } } as any;
  const renderer = new MessageRenderer(plugin, new Component(), messages);
  const stream = new StreamController({ plugin, state, renderer,
    subagentManager: new SubagentManager(() => undefined), getMessagesEl: () => messages, updateQueueIndicator: () => undefined,
  });
  const response: ChatMessage = { id: 'response', role: 'assistant', timestamp: testDate().getTime(), content: '', contentBlocks: [] };
  state.addMessage(response);
  state.currentContentEl = renderer.addMessage(response).querySelector('.claudian-message-content');
  return { stream, response, close: () => messages.remove() };
}

/** Replays native RPC execution events through Pi normalization and the chat stream. */
async function restoreLive(call: NativeToolCall): Promise<ToolCallInfo> {
  const normalization = createPiEventNormalizationState();
  const result = { content: textParts(call), details: call.details ?? {} };
  const chunks = [
    { type: 'tool_execution_start', toolCallId: 'tool', toolName: call.name, args: call.args },
    ...(call.nested ?? []).map(event => ({ ...event, parentToolCallId: 'tool' })),
    { type: 'tool_execution_end', toolCallId: 'tool', toolName: call.name, result, isError: call.isError ?? false },
  ].flatMap(event => normalizePiRPCEvent(event, normalization));

  const { stream, response, close } = createChatStream();
  for (const chunk of chunks) await stream.handleStreamChunk(chunk, response);
  close();
  expect(response.toolCalls).toHaveLength(1);
  return response.toolCalls![0];
}

/** Restores the same call from Pi's session JSONL, as written by the native session manager. */
function restoreHistory(call: NativeToolCall): ToolCallInfo {
  const content = [
    { type: 'message', id: 'assistant', parentId: null, message: {
      role: 'assistant', content: [{ type: 'toolCall', id: 'tool', name: call.name, arguments: call.args }], stopReason: 'toolUse',
    } },
    { type: 'message', id: 'result', parentId: 'assistant', message: {
      role: 'toolResult', toolCallId: 'tool', toolName: call.name,
      content: textParts(call), ...(call.details ? { details: call.details } : {}), isError: call.isError ?? false,
      ...(call.nested ? { nestedCalls: { complete: true, calls: call.nested
        .filter(event => event.type === 'tool_execution_start')
        .map(event => ({ id: event.toolCallId, name: event.toolName, status: 'ok', arguments: event.args })) } } : {}),
    } },
  ].map(entry => JSON.stringify(entry)).join('\n');
  const [message] = parsePiSessionContent(content);
  expect(message.toolCalls).toHaveLength(1);
  return message.toolCalls![0];
}

const restore = (mode: 'live' | 'history', call: NativeToolCall) => mode === 'live'
  ? restoreLive(call)
  : Promise.resolve(restoreHistory(call));

const expand = (block: HTMLElement, name: RegExp) => {
  const header = within(block).getByRole('button', { name });
  fireEvent.keyDown(header, { key: 'Enter' });
  return header;
};

describe.each(['live', 'history'] as const)('%s Pi tool presentation', mode => {
  it.each(['1→literal arrow', '1→first transition\n2→second transition'])('preserves plain read text: %j', async text => {
    const tool = await restore(mode, { name: 'read', args: { path: 'arrows.md' }, text });
    const block = renderStoredToolCall(document.body.createDiv(), tool);
    expand(block, /^Read: arrows\.md/);
    expect([...block.querySelectorAll('.claudian-tool-line')].map(line => line.textContent)).toEqual(text.split('\n'));
  });

  it('builds edit diffs from the native unified patch, not the numbered display diff', async () => {
    const tool = await restore(mode, {
      name: 'edit',
      args: { path: 'notes/plan.md', edits: [{ oldText: 'Draft', newText: 'Final\n\nShipped.' }] },
      text: 'Successfully replaced 1 block(s) in notes/plan.md.',
      details: {
        // Pi's TUI diff: gutters carry line numbers and `...` marks elided context.
        diff: '     ...\n 41 ## Status\n 42 \n-43 Draft\n+43 Final\n+44 \n+45 Shipped.\n 44 ',
        patch: [
          '--- notes/plan.md', '+++ notes/plan.md', '@@ -41,4 +41,6 @@', ' ## Status', ' ', '-Draft', '+Final', '+', '+Shipped.', ' ', '',
        ].join('\n'),
        firstChangedLine: 43,
      },
    });
    expect(tool).toMatchObject({ name: 'Edit', status: 'completed' });
    expect(getToolIcon(tool.name)).toBe('file-pen');
    expect(tool.diffData?.stats).toEqual({ added: 3, removed: 1 });
    expect(tool.diffData?.diffLines.slice(0, 4)).toEqual([
      { type: 'equal', text: '## Status', oldLineNum: 41, newLineNum: 41 },
      { type: 'equal', text: '', oldLineNum: 42, newLineNum: 42 },
      { type: 'delete', text: 'Draft', oldLineNum: 43 },
      { type: 'insert', text: 'Final', newLineNum: 43 },
    ]);
  });

  it('keeps failed edits as errors without a diff', async () => {
    const tool = await restore(mode, {
      name: 'edit',
      args: { path: 'notes/plan.md', edits: [{ oldText: 'Missing', newText: 'Final' }] },
      text: 'Could not find the exact text in notes/plan.md. The old text must match exactly including all whitespace and newlines.',
      isError: true,
    });
    expect(tool).toMatchObject({ name: 'Edit', status: 'error' });
    expect(tool.diffData).toBeUndefined();
  });

  it.each([
    ['bash', 'make check'],
    ['powershell', 'Get-ChildItem'],
  ])('renders the native %s tool as a shell command with its exit status', async (name, command) => {
    const tool = await restore(mode, {
      name, args: { command }, text: 'boom\n\nCommand exited with code 2', isError: true,
    });
    expect(tool).toMatchObject({ name: 'Bash', status: 'error' });
    expect(getToolIcon(tool.name)).toBe('terminal');
    const block = renderStoredToolCall(document.body.createDiv(), tool);
    expand(block, new RegExp(`^Bash: ${command}`));
    expect(within(block).getByText(`$ ${command}`)).toBeDefined();
    expect(within(block).getByText('Command exited with code 2')).toBeDefined();
  });

  it('renders web search hits as links with their age and snippet', async () => {
    const tool = await restore(mode, {
      name: 'web_search', args: { query: 'pi rpc events', count: 2 },
      text: 'Brave web search results for: pi rpc events\n\n--- Result 1 ---\nTitle: RPC mode\nURL: https://pi.dev/docs/rpc',
      details: { provider: 'brave', query: 'pi rpc events', count: 2, status: 200, results: [
        { title: 'RPC mode', url: 'https://pi.dev/docs/rpc', description: 'Stream agent events as JSON lines.', age: '2 days ago' },
        { title: 'Extensions', url: 'https://pi.dev/docs/extensions', description: 'Register custom tools.' },
      ] },
    });
    expect(getToolIcon(tool.name)).toBe('globe');
    const block = renderStoredToolCall(document.body.createDiv(), tool);
    expand(block, /^WebSearch: pi rpc events/);
    expect(within(block).getByRole('link', { name: 'RPC mode' }).getAttribute('href')).toBe('https://pi.dev/docs/rpc');
    expect(within(block).getByRole('link', { name: 'Extensions' }).getAttribute('href')).toBe('https://pi.dev/docs/extensions');
    expect(within(block).getByText('2 days ago · Stream agent events as JSON lines.')).toBeDefined();
    expect(within(block).getByText('Register custom tools.')).toBeDefined();
    expect((await axe(block)).violations).toEqual([]);
  });

  it('summarizes file search tools by their native pattern and path', async () => {
    const find = await restore(mode, { name: 'find', args: { pattern: '**/*.md', path: 'notes' }, text: 'plan.md\nideas/todo.md' });
    expect(getToolIcon(find.name)).toBe('folder-search');
    const block = renderStoredToolCall(document.body.createDiv(), find);
    expand(block, /^Glob: \*\*\/\*\.md/);
    expect([...block.querySelectorAll('.claudian-tool-line')].map(line => line.textContent)).toEqual(['plan.md', 'ideas/todo.md']);

    const ls = await restore(mode, { name: 'ls', args: { path: 'notes' }, text: 'plan.md\nideas/' });
    expect(getToolIcon(ls.name)).toBe('list');
    expand(renderStoredToolCall(document.body.createDiv(), ls), /^LS: notes/);
  });

  describe('codemode', () => {
    const code = 'const [notes, plan] = await Promise.all([\n  tools.read({ path: "notes.md" }),\n  tools.read({ path: "plan.md" }),\n]);\nawait tools.edit({ path: "plan.md", edits: [{ oldText: "Draft", newText: "Final" }] });\ntext(`notes=${notes.length} plan=${plan.length}`);';
    // Captured from Pi 0.99.2 `--mode json`: nested calls stream as their own events, tagged with the script's call ID.
    const nestedEdit = [
      { type: 'tool_execution_start', toolCallId: 'tool/3', toolName: 'edit', args: { path: 'plan.md', edits: [{ oldText: 'Draft', newText: 'Final' }] } },
      { type: 'tool_execution_end', toolCallId: 'tool/3', toolName: 'edit', isError: false, result: {
        content: [{ type: 'text', text: 'Successfully replaced 1 block(s) in plan.md.' }],
        details: { diff: ' 1 # Plan\n-2 Draft\n+2 Final', patch: '--- plan.md\n+++ plan.md\n@@ -1,2 +1,2 @@\n # Plan\n-Draft\n+Final\n' },
      } },
    ];

    it('renders the script, its nested tool calls, and output without the native header', async () => {
      const tool = await restore(mode, {
        name: 'codemode', args: { code },
        text: ['Script completed\nWall time 0.0 seconds\nOutput:\n', 'notes=17 plan=13'],
        details: { calls: [
          { id: 'tool/1', name: 'read', args: '{"path":"notes.md"}', status: 'ok', durationMs: 3.85 },
          { id: 'tool/2', name: 'read', args: '{"path":"plan.md"}', status: 'ok', durationMs: 2.89 },
          // Pi caps this preview at 200 characters, so long arguments arrive as cut-off JSON.
          { id: 'tool/3', name: 'edit', args: '{"path":"plan.md","edits":[{"oldText":"Draft","newTe...', status: 'ok', durationMs: 1250 },
        ] },
        nested: [
          { type: 'tool_execution_start', toolCallId: 'tool/1', toolName: 'read', args: { path: 'notes.md' } },
          { type: 'tool_execution_update', toolCallId: 'tool/1', toolName: 'read', args: { path: 'notes.md' }, partialResult: { content: [{ type: 'text', text: 'alpha' }] } },
          { type: 'tool_execution_end', toolCallId: 'tool/1', toolName: 'read', isError: false, result: { content: [{ type: 'text', text: 'alpha\nbeta\ngamma\n' }] } },
          ...nestedEdit,
        ],
      });
      expect(tool).toMatchObject({ status: 'completed', result: 'notes=17 plan=13' });
      expect(getToolIcon(tool.name)).toBe('code');
      const block = renderStoredToolCall(document.body.createDiv(), tool);
      expand(block, /^Script: const \[notes, plan\] = await Promise\.all\(\[/);
      expect(block.querySelector('code')?.textContent).toBe(code);
      expect(block.querySelector('.claudian-tool-script-output')?.textContent).toBe('notes=17 plan=13');
      const calls = within(within(block).getByRole('list', { name: 'Tool calls' })).getAllByRole('listitem');
      expect(calls.map(call => call.textContent)).toEqual(['Read notes.md 4ms', 'Read plan.md 3ms', 'Edit plan.md 1.3s']);
      expect(within(block).getAllByRole('img', { name: 'Status: completed' })).toHaveLength(3);
      expect((await axe(block)).violations).toEqual([]);
    });

    it('keeps a failed script as an error with its partial output and the failing call', async () => {
      const failure = "ENOENT: no such file or directory, access '/vault/missing.md'";
      const tool = await restore(mode, {
        name: 'codemode', args: { code: "text('starting');\nawait tools.read({ path: 'missing.md' });" }, isError: true,
        text: ['Script failed\nWall time 0.0 seconds\nOutput:\n', 'starting',
          `Script error:\nError: ${failure}\n\nTool calls made before the failure (they are not undone): read (error)`],
        details: { calls: [
          { id: 'tool/1', name: 'read', args: '{"path":"missing.md","offset":null,"limit":null}', status: 'error', durationMs: 2.33, error: failure },
        ] },
        nested: [
          { type: 'tool_execution_start', toolCallId: 'tool/1', toolName: 'read', args: { path: 'missing.md' } },
          { type: 'tool_execution_end', toolCallId: 'tool/1', toolName: 'read', isError: true, result: { content: [{ type: 'text', text: failure }], details: {} } },
        ],
      });
      expect(tool.status).toBe('error');
      const block = renderStoredToolCall(document.body.createDiv(), tool);
      expand(block, /^Script: text\('starting'\);/);
      expect(block.querySelector('.claudian-tool-script-output')?.textContent).toBe(
        `starting\nScript error:\nError: ${failure}\n\nTool calls made before the failure (they are not undone): read (error)`,
      );
      const [call] = within(within(block).getByRole('list', { name: 'Tool calls' })).getAllByRole('listitem');
      expect(within(call).getByRole('img', { name: 'Status: error' })).toBeDefined();
      expect(within(call).getByText(failure)).toBeDefined();
    });
  });
});

it('streams a running script\'s nested calls through the Pi session and refreshes files written before cancellation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-script-progress-'));
  const configuration = { model: 'pi:anthropic/claude-sonnet-4', reasoning: null, systemInstructions: { kind: 'provider-default' as const } };
  const host = {
    getResolvedProviderCliPath: async () => process.execPath,
    settings: { model: configuration.model, effortLevel: 'off', systemPrompt: '', userName: '',
      providerConfigs: { pi: { enabled: true, visibleModels: [configuration.model],
        discoveredModels: [{ encodedId: configuration.model, id: 'claude-sonnet-4', provider: 'anthropic', label: 'Sonnet', input: ['text'], reasoning: false, thinkingLevels: ['off'] }] } } },
  };
  const backend = new PiExecutionBackend(host as any, { commandCatalog: { setCommandSnapshot: jest.fn() } } as any, {
    createKernel: (spec, callbacks) => new PiRPCSessionKernel({ ...spec, command: process.execPath,
      args: [path.resolve('tests/fixtures/providers/pi/PiSessionProcess.mjs'), ...spec.args],
      env: { ...spec.env, CLAUDIAN_TEST_PI_ROOT: root },
    }, callbacks, null),
  });
  const session = backend.createSession({
    lifecycle: 'ephemeral', nativePersistence: 'disabled-if-supported', vaultWorkingDirectory: root,
    interactionPort: { askUserQuestion: jest.fn(), requestApproval: jest.fn(), dismissInteraction: jest.fn() },
  });
  const { stream, response, close } = createChatStream();
  try {
    // Captured from Pi 0.99.2: the script wrote out/new.md and is still running `sleep 2` through bash.
    const run = session.execute({ configuration, toolPolicy: { kind: 'provider-default' },
      input: [{ type: 'text', text: 'replay:codemode-write-running.jsonl' }], signal: new AbortController().signal });
    // Without live progress the script never shows its bash call; the timer still ends the run.
    const fallback = setTimeout(() => run.cancel(), 3000);
    for await (const event of run.events) {
      const chunk = providerOutputEventToStreamChunk(event);
      if (chunk) await stream.handleStreamChunk(chunk, response);
      if (response.toolCalls?.[0]?.scriptToolCalls?.length === 2) run.cancel();
    }
    clearTimeout(fallback);
    await new Promise(resolve => setTimeout(resolve, 250));

    expect(listVaultFolder).toHaveBeenCalledWith('out');
    expect(response.toolCalls).toHaveLength(1);
    const block = renderStoredToolCall(document.body.createDiv(), { ...response.toolCalls![0], status: 'running' });
    const calls = within(within(block).getByRole('list', { name: 'Tool calls' })).getAllByRole('listitem');
    expect(calls.map(call => call.textContent?.replace(/ \d+ms$/, ''))).toEqual(['Write new.md', 'Bash sleep 2']);
    expect(within(calls[0]).getByRole('img', { name: 'Status: completed' })).toBeDefined();
    expect(within(calls[1]).getByRole('img', { name: 'Status: running' })).toBeDefined();
    expect(within(block).getByText('Running...')).toBeDefined();
  } finally {
    close();
    await session.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});
