/** @jest-environment jsdom */
import '@/providers';

import { testDate } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { Component } from 'obsidian';

import type { ProviderExecutionEvent } from '@/core/execution';
import { getToolIcon } from '@/core/tools/toolIcons';
import type { ChatMessage, StreamChunk, ToolCallInfo } from '@/core/types';
import { providerOutputEventToStreamChunk, StreamController } from '@/features/chat/controllers/StreamController';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { renderStoredToolCall } from '@/features/chat/rendering/ToolCallRenderer';
import { SubagentManager } from '@/features/chat/services/SubagentManager';
import { ChatState } from '@/features/chat/state/ChatState';
import { OpencodeHTTPSessionKernel } from '@/providers/opencode/execution/OpencodeHTTPSessionKernel';
import { OpencodeSessionPersistence } from '@/providers/opencode/execution/OpencodeSessionPersistence';
import { mapOpencodeV2NativeMessages } from '@/providers/opencode/history/OpencodeHistoryStore';
import type { OpencodeHTTPEvent } from '@/providers/opencode/http/OpencodeHTTPClient';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
HTMLElement.prototype.toggleClass = function (names, enabled) {
  for (const name of Array.isArray(names) ? names : [names]) this.classList.toggle(name, enabled);
};
HTMLElement.prototype.scrollIntoView = function () {};
HTMLElement.prototype.setText = function (text) { this.textContent = String(text); };

beforeEach(() => document.body.replaceChildren());

interface NativeToolCall {
  name: string;
  input: Record<string, unknown>;
  content?: string[];
  metadata?: Record<string, unknown>;
  error?: { type: string; message: string };
}

/** Replays one native V2 tool call through the live HTTP kernel and chat stream. */
async function restoreLiveV2(call: NativeToolCall): Promise<ToolCallInfo> {
  let receive!: (event: OpencodeHTTPEvent) => void;
  const output: ProviderExecutionEvent[] = [];
  const lease = {
    databasePath: null, isReusable: () => true,
    subscribe: async (callback: typeof receive) => { receive = callback; },
    registerAgents: async () => ({}), waitForActivation: async () => {}, refreshGlobalForms: async () => {},
    dispose: async () => {},
    request: async (route: string) => {
      if (route === '/api/model') return { data: [{ id: 'model', providerID: 'test', enabled: true }] };
      if (route === '/api/command') return { data: [] };
      return { data: { id: 'ses_main' } };
    },
  };
  const config = { vaultWorkingDirectory: '/workspace', lifecycle: 'persistent', nativePersistence: 'provider-default', interactionPort: { dismissInteraction: jest.fn() } } as any;
  const kernel = new OpencodeHTTPSessionKernel({ config, getActiveTurnId: () => 'turn',
    onNativeOutput: (event: ProviderExecutionEvent) => output.push(event), onNativeTurn: jest.fn(), onClosed: jest.fn(),
  } as any, '/opencode', {}, { acquire: async () => lease } as any, new OpencodeSessionPersistence(config));
  try {
    await kernel.connect({ profile: 'managed', systemInstructions: { kind: 'explicit', instructions: '' } } as any);
    await kernel.openSession();
    const event = (type: string, data: Record<string, unknown> = {}) => receive({ type, data: {
      sessionID: 'ses_main', assistantMessageID: 'msg_main', id: 'tool', ...data,
    } });
    event('session.tool.input.started', { name: call.name });
    event('session.tool.called', { input: call.input, executed: true });
    if (call.error) {
      event('session.tool.failed', { error: call.error, metadata: call.metadata, executed: true });
    } else {
      event('session.tool.success', {
        content: (call.content ?? []).map(text => ({ type: 'text', text })), metadata: call.metadata, executed: true,
      });
    }
  } finally {
    await kernel.dispose();
  }
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
    if (chunk?.type === 'tool_use' || chunk?.type === 'tool_result') await stream.handleStreamChunk(chunk as StreamChunk, response);
  }
  messages.remove();
  expect(response.toolCalls).toHaveLength(1);
  return response.toolCalls![0];
}

function restoreV2History(call: NativeToolCall): ToolCallInfo {
  const state = call.error
    ? { status: 'error', input: call.input, error: call.error, metadata: call.metadata ?? null, content: null }
    : { status: 'completed', input: call.input, metadata: call.metadata, content: (call.content ?? []).map(text => ({ type: 'text', text })) };
  const [message] = mapOpencodeV2NativeMessages([{
    id: 'msg', type: 'assistant', time_created: testDate().getTime(),
    content: [{ type: 'tool', id: 'tool', name: call.name, state }],
  }]);
  expect(message.toolCalls).toHaveLength(1);
  return message.toolCalls![0];
}

const restore = (mode: 'live' | 'history', call: NativeToolCall) => mode === 'live'
  ? restoreLiveV2(call)
  : Promise.resolve(restoreV2History(call));

const expand = (block: HTMLElement, name: RegExp) => {
  const header = within(block).getByRole('button', { name });
  fireEvent.keyDown(header, { key: 'Enter' });
  return header;
};

const lines = (block: HTMLElement) => [...block.querySelectorAll('.claudian-tool-line')].map(line => line.textContent);

describe.each(['live', 'history'] as const)('%s OpenCode V2 tool presentation', mode => {
  it('renders code-mode execute as a JavaScript script with its output', async () => {
    const code = 'return await tools.browser.preview({ path: "DEMO.md" });';
    const tool = await restore(mode, {
      name: 'execute', input: { code },
      content: ['Preview opened'], metadata: { toolCalls: [{ tool: 'browser.preview', status: 'completed' }], truncated: false },
    });
    expect(tool.status).toBe('completed');
    expect(getToolIcon(tool.name)).toBe('code');
    const block = renderStoredToolCall(document.body.createDiv(), tool);
    expand(block, /^Script: return await tools\.browser\.preview/);
    expect(block.querySelector('code')?.textContent).toBe(code);
    expect(block.querySelector('.claudian-tool-script-output')?.textContent).toBe('Preview opened');
    expect((await axe(block)).violations).toEqual([]);
  });

  it('marks code-mode failures reported only through metadata as errors', async () => {
    const tool = await restore(mode, {
      name: 'execute', input: { code: 'return await tools.browser.preview({});' },
      content: ['[browser.disconnected] No desktop browser is connected to this session.'],
      metadata: { toolCalls: [{ tool: 'browser.preview', status: 'error' }], error: true, truncated: false },
    });
    expect(tool.status).toBe('error');
  });

  it.each([
    [{ status: 'completed', exit: 0, truncated: false }, 'completed'],
    [{ status: 'completed', exit: 2, truncated: false }, 'error'],
    [{ status: 'completed', signal: 'SIGKILL', truncated: false }, 'error'],
    [{ status: 'completed', timeout: true, truncated: false }, 'error'],
  ] as const)('derives shell status from native termination metadata %#', async (metadata, status) => {
    const tool = await restore(mode, { name: 'shell', input: { command: 'make check' }, content: ['output'], metadata });
    expect(tool).toMatchObject({ name: 'Bash', status });
  });

  it('builds edit diffs from the native patch, including surrounding context', async () => {
    const tool = await restore(mode, {
      name: 'edit',
      input: { path: 'DEMO.md', oldString: '| Table | Aligned columns |', newString: '| Table | Aligned columns |\n\nRound 3.' },
      content: ['Edited DEMO.md (1 replacement)'],
      metadata: { truncated: false, files: [{ file: 'DEMO.md', status: 'modified', additions: 2, deletions: 0, patch: [
        'Index: DEMO.md', '===================================================================', '--- DEMO.md', '+++ DEMO.md',
        '@@ -87,4 +87,6 @@', ' | Callout | Colored box with title |', ' | Math block | Centered display equation |',
        ' | Table | Aligned columns |', ' ', '+Round 3.', '+', '',
      ].join('\n') }] },
    });
    expect(tool.name).toBe('Edit');
    expect(tool.diffData?.stats).toEqual({ added: 2, removed: 0 });
    expect(tool.diffData?.diffLines[0]).toEqual({ type: 'equal', text: '| Callout | Colored box with title |', oldLineNum: 87, newLineNum: 87 });
  });

  it('renders the patch tool as per-file apply_patch diffs', async () => {
    const tool = await restore(mode, {
      name: 'patch',
      input: { patchText: '*** Begin Patch\n*** Update File: notes/plan.md\n@@\n-Draft\n+Final\n*** Add File: notes/new.md\n+Created\n*** End Patch' },
      content: ['Success. Updated the following files:\nM notes/plan.md\nA notes/new.md'],
      metadata: { truncated: false, files: [] },
    });
    expect(getToolIcon(tool.name)).toBe(getToolIcon('apply_patch'));
    const block = renderStoredToolCall(document.body.createDiv(), tool);
    expand(block, /^apply_patch: 2 files/);
    expect([...block.querySelectorAll('.claudian-diff-insert .claudian-diff-text')].map(line => line.textContent))
      .toEqual(expect.arrayContaining(['Final', 'Created']));
  });

  it('shows read output without the native header or line-number gutter', async () => {
    const tool = await restore(mode, {
      name: 'read', input: { path: 'DEMO.md', offset: 70 },
      content: ['Read file DEMO.md, lines 70-72\n70: Alpha\n71: 12: literal colon\n72: '], metadata: { truncated: false },
    });
    const block = renderStoredToolCall(document.body.createDiv(), tool);
    expand(block, /^Read: DEMO\.md/);
    expect(lines(block)).toEqual(['Alpha', '12: literal colon', ' ']);
  });

  it('renders web search hits as links with their date and snippet', async () => {
    const published = testDate().toISOString();
    const tool = await restore(mode, {
      name: 'websearch', input: { query: 'AAPL price' },
      content: [`## [Stock Price](https://investor.apple.com/stock-price/)\nPublished: ${published}\nQuote snippet\n\n## [AAPL Quote](https://finance.example.com/AAPL)\nSecond snippet`],
      metadata: { provider: 'tinyfish', truncated: false },
    });
    const block = renderStoredToolCall(document.body.createDiv(), tool);
    expand(block, /AAPL price/);
    expect(within(block).getByRole('link', { name: 'Stock Price' }).getAttribute('href')).toBe('https://investor.apple.com/stock-price/');
    expect(within(block).getByRole('link', { name: 'AAPL Quote' }).getAttribute('href')).toBe('https://finance.example.com/AAPL');
    expect(within(block).getByText(`${published} · Quote snippet`)).toBeDefined();
    expect(within(block).getByText('Second snippet')).toBeDefined();
    expect((await axe(block)).violations).toEqual([]);
  });
});
