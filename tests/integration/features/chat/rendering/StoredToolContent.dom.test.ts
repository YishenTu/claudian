/** @vitest-environment jsdom */
import { axe } from '@test/helpers/accessibility';
import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { testClock } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';

import type { ChatMessage, ToolCallInfo } from '@/core/types';
import {
  renderStoredToolCall,
  renderToolCall,
  updateToolCallResult,
} from '@/features/chat/rendering/tools/ToolCallRenderer';
import { createWriteEditBlock, finalizeWriteEditBlock, renderStoredWriteEdit,updateWriteEditWithDiff } from '@/features/chat/rendering/tools/WriteEditRenderer';
import { ChatState } from '@/features/chat/state/ChatState';
import { ToolCallStream, type ToolCallStreamDeps } from '@/features/chat/turns/ToolCallStream';
import { setLocale } from '@/i18n/i18n';

beforeEach(() => { document.body.replaceChildren(); });
afterEach(() => setLocale('en'));

it('attributes expanded native patch changes to their paths and rename destinations', async () => {
  const card = renderStoredToolCall(document.body.createDiv(), {
    id: 'multiple-files', name: 'apply_patch', status: 'completed',
    input: { patch: '*** Begin Patch\n*** Update File: source/first.md\n@@\n-old first\n+new first\n*** Update File: source/second.md\n*** Move to: moved/second.md\n@@\n-old second\n+new second\n*** End Patch' },
  });
  fireEvent.click(within(card).getByRole('button', { name: /apply_patch:/ }));
  const first = within(card).getByRole('group', { name: 'source/first.md' });
  const moved = within(card).getByRole('group', { name: 'source/second.md -> moved/second.md' });
  expect(within(first).getByText('new first')).toBeDefined();
  expect(within(first).queryByText('new second')).toBeNull();
  expect(within(moved).getByText('new second')).toBeDefined();
  expect(within(moved).queryByText('new first')).toBeNull();
  expect(await axe(card)).toHaveNoViolations();
});

it.each(['\n', '\r\n'])('retains legacy WebSearch source links before a %j boundary', async newline => {
  const card = renderStoredToolCall(document.body.createDiv(), {
    id: 'legacy-search', name: 'WebSearch', status: 'completed',
    input: { query: 'Obsidian docs' },
    result: `Links: [{"title":"Obsidian API","url":"https://docs.obsidian.md/"}]${newline}${newline}Answer`,
  });
  fireEvent.click(within(card).getByRole('button', { name: /WebSearch:/ }));
  expect(within(card).getByRole('link', { name: 'Obsidian API' }).getAttribute('href'))
    .toBe('https://docs.obsidian.md/');
  expect(within(card).queryByText('Answer')).toBeNull();
  expect(await axe(card)).toHaveNoViolations();
});

function createToolStream(expandFileEditsByDefault = false) {
  const parent = document.body.createDiv();
  const state = new ChatState();
  state.currentContentEl = parent;
  const stream = new ToolCallStream({
    state,
    plugin: { app: {}, settings: { expandFileEditsByDefault } } as ToolCallStreamDeps['plugin'],
    indicator: { show: () => undefined },
    getMessagesEl: () => parent,
    scrollToBottom: () => undefined,
  });
  const message: ChatMessage = {
    id: 'refined-response', role: 'assistant', content: '', timestamp: testClock()().getTime(), toolCalls: [],
  };
  return { parent, state, stream, message };
}

it('refreshes a flushed Bash header without settling, rebuilding or expanding its card', async () => {
  const { parent, state, stream, message } = createToolStream();
  try {
    stream.use({ type: 'tool_use', id: 'refined-bash', name: 'Bash', input: {} }, message);
    stream.flush();
    const card = state.toolCallElements.get('refined-bash')!;
    const header = within(card).getByRole('button', { name: 'Bash: command - click to expand' });
    const content = card.querySelector('.claudian-tool-content')!;
    const tool = message.toolCalls![0];
    expect(content.childElementCount).toBe(0);

    stream.use({ type: 'tool_use', id: 'refined-bash', name: 'Bash', input: { command: 'printf refined' } }, message);
    expect(card.querySelector('.claudian-tool-summary')?.textContent).toBe('printf refined');
    expect(within(card).getByRole('button', { name: 'Bash: printf refined - click to expand' })).toBe(header);
    expect(state.toolCallElements.get('refined-bash')).toBe(card);
    expect(message.toolCalls).toHaveLength(1);
    expect(message.toolCalls?.[0]).toBe(tool);
    expect(tool.status).toBe('running');
    expect(card.querySelector('.claudian-tool-status')?.getAttribute('aria-label')).toBe('Status: running');
    expect(content.childElementCount).toBe(0);
    expect(header.getAttribute('aria-expanded')).toBe('false');

    stream.use({ type: 'tool_use', id: 'refined-bash', name: 'Bash', input: {} }, message);
    expect(tool.input).toEqual({ command: 'printf refined' });
    fireEvent.keyDown(header, { key: 'Enter' });
    expect(within(card).getByRole('button', { name: 'Bash: printf refined - click to collapse' })).toBe(header);
    expect(content.textContent).toContain('Running...');
    expect(tool.status).toBe('running');
    stream.complete({ type: 'tool_result', id: 'refined-bash', content: 'Refined output' }, message);
    expect(content.textContent).toContain('Refined output');
    expect(tool.status).toBe('completed');
    fireEvent.keyDown(header, { key: ' ' });
    expect(within(card).getByRole('button', { name: 'Bash: printf refined - click to expand' })).toBe(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    const renderedBody = content.firstElementChild;
    fireEvent.click(header);
    expect(within(card).getByRole('button', { name: 'Bash: printf refined - click to collapse' })).toBe(header);
    expect(content.firstElementChild).toBe(renderedBody);
    expect(await axe(parent)).toHaveNoViolations();
  } finally {
    stream.cancelAll();
  }
});

it.each([false, true])('refines a rendered Read input through real header owners, expanded: %s', async initiallyExpanded => {
  const { parent, state, stream, message } = createToolStream();
  try {
    stream.use({ type: 'tool_use', id: 'read-refinement', name: 'Read', input: { file_path: 'notes/original.md', offset: 4 } }, message);
    stream.flush();
    const card = state.toolCallElements.get('read-refinement')!;
    const header = within(card).getByRole('button', { name: 'Read: notes/original.md - click to expand' });
    if (initiallyExpanded) fireEvent.click(header);
    const content = card.querySelector('.claudian-tool-content')!;
    const body = content.firstElementChild;
    const tool = message.toolCalls![0];

    stream.use({ type: 'tool_use', id: 'read-refinement', name: 'Read', input: { file_path: 'notes/updated.md' } }, message);
    const suffix = initiallyExpanded ? 'collapse' : 'expand';
    expect(within(card).getByRole('button', { name: `Read: notes/updated.md - click to ${suffix}` })).toBe(header);
    expect(card.querySelector('.claudian-tool-summary')?.textContent).toBe('updated.md');
    expect(state.toolCallElements.get('read-refinement')).toBe(card);
    expect(message.toolCalls).toHaveLength(1);
    expect(message.toolCalls![0]).toBe(tool);
    expect(tool.input).toEqual({ file_path: 'notes/updated.md', offset: 4 });
    expect(tool.status).toBe('running');
    expect(tool.isExpanded).toBe(initiallyExpanded);
    expect(header.getAttribute('aria-expanded')).toBe(String(initiallyExpanded));
    expect(content.childElementCount > 0).toBe(initiallyExpanded);
    expect(content.firstElementChild).toBe(body);
    stream.use({ type: 'tool_use', id: 'read-refinement', name: 'Read', input: {} }, message);
    expect(tool.input).toEqual({ file_path: 'notes/updated.md', offset: 4 });
    fireEvent.keyDown(header, { key: 'Enter' });
    expect(within(card).getByRole('button', { name: `Read: notes/updated.md - click to ${initiallyExpanded ? 'expand' : 'collapse'}` })).toBe(header);
    expect(await axe(parent)).toHaveNoViolations();
  } finally {
    stream.cancelAll();
  }
});

it('presents a title-only generic-to-Read refinement with retained logical identity and order', async () => {
  const { parent, state, stream, message } = createToolStream();
  try {
    stream.use({ type: 'tool_use', id: 'title-only', name: 'tool', input: { file_path: 'notes/retained.md', offset: 2 } }, message);
    stream.use({ type: 'tool_use', id: 'following', name: 'Bash', input: { command: 'printf following' } }, message);
    stream.flush();
    const original = state.toolCallElements.get('title-only')!;
    fireEvent.click(within(original).getByRole('button', { name: 'tool - click to expand' }));
    const tool = message.toolCalls![0];
    stream.use({ type: 'tool_use', id: 'title-only', name: 'Read', input: {} }, message);
    const current = state.toolCallElements.get('title-only')!;
    const header = within(current).getByRole('button', { name: 'Read: notes/retained.md - click to collapse' });
    expect(current.querySelector('.claudian-tool-name')?.textContent).toBe('Read');
    expect(current.querySelector('.claudian-tool-summary')?.textContent).toBe('retained.md');
    expect(message.toolCalls).toHaveLength(2);
    expect(message.toolCalls![0]).toBe(tool);
    expect(tool).toMatchObject({ id: 'title-only', name: 'Read', input: { file_path: 'notes/retained.md', offset: 2 }, status: 'running', isExpanded: true });
    expect(Array.from(parent.children, card => card.getAttribute('data-tool-id'))).toEqual(['title-only', 'following']);
    expect(message.contentBlocks).toEqual([{ type: 'tool_use', toolId: 'title-only' }, { type: 'tool_use', toolId: 'following' }]);
    stream.use({ type: 'tool_use', id: 'title-only', name: 'Read', input: {} }, message);
    expect(tool.input).toEqual({ file_path: 'notes/retained.md', offset: 2 });
    fireEvent.keyDown(header, { key: ' ' });
    expect(within(current).getByRole('button', { name: 'Read: notes/retained.md - click to expand' })).toBe(header);
    expect(await axe(parent)).toHaveNoViolations();
  } finally {
    stream.cancelAll();
  }
});

it('refreshes an expanded specialized Edit filename while preserving its state and diff', async () => {
  const { parent, state, stream, message } = createToolStream(true);
  try {
    stream.use({ type: 'tool_use', id: 'refined-edit', name: 'Edit', input: {} }, message);
    stream.flush();
    const edit = state.writeEditStates.get('refined-edit')!;
    const header = within(edit.wrapperEl).getByRole('button', { name: 'Edit: file - click to collapse' });
    const loadingBody = edit.contentEl.firstElementChild;

    stream.use({ type: 'tool_use', id: 'refined-edit', name: 'Edit', input: { file_path: 'project/refined.md' } }, message);
    expect(edit.summaryEl.textContent).toBe('refined.md');
    expect(within(edit.wrapperEl).getByRole('button', { name: 'Edit: project/refined.md - click to collapse' })).toBe(header);
    expect(state.writeEditStates.get('refined-edit')).toBe(edit);
    expect(state.toolCallElements.get('refined-edit')).toBe(edit.wrapperEl);
    expect(edit.isExpanded).toBe(true);
    expect(edit.toolCall.status).toBe('running');
    expect(edit.contentEl.firstElementChild).toBe(loadingBody);
    stream.use({ type: 'tool_use', id: 'refined-edit', name: 'Edit', input: {} }, message);
    expect(edit.toolCall.input).toEqual({ file_path: 'project/refined.md' });
    updateWriteEditWithDiff(edit, {
      filePath: 'project/refined.md',
      diffLines: [{ type: 'insert', text: 'Refined line', newLineNum: 1 }],
      stats: { added: 1, removed: 0 },
    });
    expect(edit.contentEl.textContent).toContain('Refined line');
    fireEvent.keyDown(header, { key: ' ' });
    expect(within(edit.wrapperEl).getByRole('button', { name: 'Edit: project/refined.md - click to expand' })).toBe(header);
    const diffBody = edit.contentEl.firstElementChild;
    fireEvent.click(header);
    expect(within(edit.wrapperEl).getByRole('button', { name: 'Edit: project/refined.md - click to collapse' })).toBe(header);
    expect(edit.contentEl.firstElementChild).toBe(diffBody);
    expect(await axe(parent)).toHaveNoViolations();
  } finally {
    stream.cancelAll();
  }
});

it.each([false, true])('refreshes replacement result snapshots without changing expansion %s', async initiallyExpanded => {
  const tool: ToolCallInfo = { id: 'replaced-read', name: 'Read', input: {}, status: 'running' };
  const card = renderToolCall(document.body.createDiv(), tool, { initiallyExpanded });
  const header = within(card).getByRole('button');
  const content = card.querySelector('.claudian-tool-content')!;
  const previousBody = content.firstElementChild;
  updateToolCallResult(card, {
    ...tool, input: { file_path: 'project/latest.md' }, status: 'completed', result: 'Latest file contents',
  });
  expect(card.querySelector('.claudian-tool-summary')?.textContent).toBe('latest.md');
  const suffix = initiallyExpanded ? 'collapse' : 'expand';
  expect(within(card).getByRole('button', { name: `Read: project/latest.md - click to ${suffix}` })).toBe(header);
  expect(header.getAttribute('aria-expanded')).toBe(String(initiallyExpanded));
  expect(card.querySelector('.claudian-tool-status')?.getAttribute('aria-label')).toBe('Status: completed');
  expect(content.firstElementChild === previousBody).toBe(!initiallyExpanded);
  fireEvent.click(header);
  fireEvent.click(header);
  expect(content.textContent).toContain('Latest file contents');
  expect(within(card).getByRole('button', { name: `Read: project/latest.md - click to ${suffix}` })).toBe(header);
  expect(await axe(card)).toHaveNoViolations();
});

it('restores a completed Bash result without mounting its collapsed body until expansion', () => {
  const tool: ToolCallInfo = {
    id: 'stored-bash',
    name: 'Bash',
    input: { command: 'printf fixture' },
    status: 'completed',
    result: 'first fixture line\nlast fixture line',
  };
  const parent = document.body.createDiv();
  const block = renderStoredToolCall(parent, tool);
  const content = block.querySelector<HTMLElement>('.claudian-tool-content')!;
  const header = within(block).getByRole('button', { name: /Bash: printf fixture/ });

  expect(header.getAttribute('aria-expanded')).toBe('false');
  expect(content.childElementCount).toBe(0);

  fireEvent.click(header);
  expect(header.getAttribute('aria-expanded')).toBe('true');
  expect(content.textContent).toContain('first fixture line');
  expect(content.textContent).toContain('last fixture line');
  const rendered = Array.from(content.children);

  fireEvent.click(header);
  fireEvent.keyDown(header, { key: 'Enter' });
  expect(content.firstElementChild).toBe(rendered[0]);
  expect(tool.result).toBe('first fixture line\nlast fixture line');
});

it('restores an Edit summary without mounting diff rows until keyboard expansion', () => {
  const tool: ToolCallInfo = {
    id: 'stored-edit',
    name: 'Edit',
    input: { file_path: 'fixture.md' },
    status: 'completed',
    diffData: {
      filePath: 'fixture.md',
      diffLines: [
        { type: 'delete', text: 'old fixture', oldLineNum: 1 },
        { type: 'insert', text: 'new fixture', newLineNum: 1 },
      ],
      stats: { added: 1, removed: 1 },
    },
  };
  const block = renderStoredWriteEdit(document.body.createDiv(), tool);
  const content = block.querySelector<HTMLElement>('.claudian-write-edit-content')!;
  const header = within(block).getByRole('button', { name: /Edit: fixture.md/ });

  expect(header.textContent).toContain('+1');
  expect(header.textContent).toContain('-1');
  expect(content.childElementCount).toBe(0);

  fireEvent.keyDown(header, { key: ' ' });
  expect(header.getAttribute('aria-expanded')).toBe('true');
  expect(Array.from(content.querySelectorAll('.claudian-diff-text'), el => el.textContent))
    .toEqual(['old fixture', 'new fixture']);
  const firstRow = content.firstElementChild;

  fireEvent.keyDown(header, { key: 'Enter' });
  fireEvent.click(header);
  expect(content.firstElementChild).toBe(firstRow);
});

describe.each(['completed', 'error', 'blocked'] as const)('stored %s output', (status) => {
  it('honors initiallyExpanded and retains the output through repeated toggles', () => {
    const tool: ToolCallInfo = {
      id: 'terminal-tool',
      name: 'Read',
      input: { file_path: 'fixture.md' },
      status,
      result: 'fixture output',
    };
    const original = JSON.stringify(tool);
    const block = renderStoredToolCall(document.body.createDiv(), tool, { initiallyExpanded: true });
    const content = block.querySelector<HTMLElement>('.claudian-tool-content')!;
    const header = within(block).getByRole('button', { name: /Read: fixture.md/ });

    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(content.textContent).toContain('fixture output');
    const children = Array.from(content.children);
    fireEvent.click(header);
    fireEvent.click(header);
    expect(content.firstElementChild).toBe(children[0]);
    expect(JSON.stringify(tool)).toBe(original);
  });

  it('preserves stored Edit status and materializes fallback output on demand', () => {
    const tool: ToolCallInfo = {
      id: 'terminal-edit',
      name: 'Edit',
      input: { file_path: 'fixture.md' },
      status,
      result: 'fixture failure',
    };
    const original = JSON.stringify(tool);
    const block = renderStoredWriteEdit(document.body.createDiv(), tool);
    const content = block.querySelector<HTMLElement>('.claudian-write-edit-content')!;
    const header = within(block).getByRole('button', { name: /Edit: fixture.md/ });

    expect(content.childElementCount).toBe(0);
    expect(block.classList.contains(status === 'completed' ? 'done' : 'error')).toBe(true);
    fireEvent.click(header);
    expect(content.textContent).toBe(status === 'completed' ? 'DONE' : 'fixture failure');
    expect(JSON.stringify(tool)).toBe(original);
  });
});

it('keeps running stored tools and expanded live result updates eager', () => {
  const tool: ToolCallInfo = {
    id: 'running-bash',
    name: 'Bash',
    input: { command: 'printf fixture' },
    status: 'running',
    result: 'partial output',
  };
  const parent = document.body.createDiv();
  const stored = renderStoredToolCall(parent, tool);
  expect(stored.querySelector('.claudian-tool-content')?.textContent).toContain('partial output');

  const runningEdit = renderStoredWriteEdit(parent, {
    ...tool, name: 'Edit', input: { file_path: 'fixture.md' },
  });
  expect(runningEdit.querySelector('.claudian-write-edit-content')?.childElementCount).toBeGreaterThan(0);

  const live = renderToolCall(parent, tool, { initiallyExpanded: true });
  tool.status = 'completed';
  tool.result = 'finished output';
  updateToolCallResult(live, tool);
  expect(live.querySelector('.claudian-tool-content')?.textContent).toContain('finished output');
});

it('keeps default-expanded Edit diffs available immediately', async () => {
  const block = renderStoredWriteEdit(document.body.createDiv(), {
    id: 'expanded-edit',
    name: 'Edit',
    status: 'completed',
    input: { file_path: 'fixture.md' },
    diffData: {
      filePath: 'fixture.md',
      diffLines: [
        { type: 'delete', text: 'before', oldLineNum: 1 },
        { type: 'insert', text: 'after', newLineNum: 1 },
      ],
      stats: { added: 1, removed: 1 },
    },
  }, { initiallyExpanded: true });
  expect(within(block).getByRole('button', { name: /Edit: fixture.md/ }).getAttribute('aria-expanded'))
    .toBe('true');
  expect(Array.from(block.querySelectorAll('.claudian-diff-text'), el => el.textContent))
    .toEqual(['before', 'after']);
  expect((await axe(block)).violations).toEqual([]);
});

it('keeps restored apply_patch statistics available before rendering its diff', () => {
  const block = renderStoredToolCall(document.body.createDiv(), {
    id: 'patch',
    name: 'apply_patch',
    status: 'completed',
    input: {
      patch: '*** Begin Patch\n*** Update File: fixture.md\n@@\n-old\n+new\n*** End Patch',
    },
    result: 'Applied patch',
  });
  const header = within(block).getByRole('button', { name: /apply_patch/ });
  const content = block.querySelector<HTMLElement>('.claudian-tool-content')!;
  expect(header.textContent).toContain('+1');
  expect(header.textContent).toContain('-1');
  expect(content.childElementCount).toBe(0);
  fireEvent.keyDown(header, { key: ' ' });
  expect(Array.from(content.querySelectorAll('.claudian-diff-text'), el => el.textContent))
    .toEqual(['old', 'new']);
});

it('renders only the latest live output when expanded and keeps expanded updates current', async () => {
  const tool: ToolCallInfo = { id: 'live', name: 'Bash', input: { command: 'echo fixture' }, status: 'running' };

  const block = renderToolCall(document.body.createDiv(), tool);
  const content = block.querySelector<HTMLElement>('.claudian-tool-content')!;
  const header = within(block).getByRole('button');
  for (let index = 0; index < 20; index++) {
    tool.result = `Output ${index}`;
    updateToolCallResult(block, tool);
  }
  expect(content.childElementCount).toBe(0);
  fireEvent.keyDown(header, { key: 'Enter' });
  expect(content.textContent).toContain('Output 19');
  tool.result = 'Latest output';
  updateToolCallResult(block, tool);
  expect(content.textContent).toContain('Latest output');
  fireEvent.click(header);
  const rendered = content.firstElementChild;
  const final = { ...tool, status: 'error' as const, result: 'Final failure' };
  updateToolCallResult(block, final);
  expect(content.firstElementChild).toBe(rendered);
  fireEvent.keyDown(header, { key: ' ' });
  expect(content.textContent).toContain('Final failure');
  expect(final.isExpanded).toBe(true);
  expect((await axe(block)).violations).toEqual([]);
});

it('defers live diff rows while keeping statistics and final status current', () => {
  const tool: ToolCallInfo = { id: 'live-edit', name: 'Edit', input: { file_path: 'fixture.md' }, status: 'running' };
  const state = createWriteEditBlock(document.body.createDiv(), tool);
  const diff = { filePath: 'fixture.md', diffLines: [{ type: 'insert' as const, text: 'first', newLineNum: 1 }], stats: { added: 1, removed: 0 } };
  updateWriteEditWithDiff(state, diff);
  expect(state.statsEl.textContent).toContain('+1');
  expect(state.contentEl.querySelector('.claudian-diff-text')).toBeNull();
  fireEvent.click(state.headerEl);
  expect(state.contentEl.textContent).toContain('first');
  fireEvent.click(state.headerEl);
  updateWriteEditWithDiff(state, { ...diff, diffLines: [{ type: 'insert', text: 'latest', newLineNum: 1 }] });
  finalizeWriteEditBlock(state, true);
  expect(state.wrapperEl.classList.contains('error')).toBe(true);
  expect(state.contentEl.textContent).not.toContain('latest');
  fireEvent.keyDown(state.headerEl, { key: 'Enter' });
  expect(state.contentEl.textContent).toContain('latest');
});


it.each(['raw', 'value'])('renders stored exec %s source safely with a Script header and separate output', async (key) => {
  const source = '// @exec: {"yield_time_ms": 1000}\nconst label = `<img src=x onerror=alert(1)>`;\ntext(label);';
  const block = renderStoredToolCall(document.body.createDiv(), {
    id: 'script', name: 'exec', input: { [key]: source }, status: 'completed', result: 'Script fixture complete',
  });
  const header = within(block).getByRole('button', { name: /Script: const label/ });
  expect(header.textContent).not.toContain('@exec');
  expect(block.querySelector('code')).toBeNull();
  fireEvent.keyDown(header, { key: 'Enter' });
  expect(within(block).getByText('JavaScript')).toBeDefined();
  expect(block.querySelector('code')?.textContent).toBe(source);
  expect(block.querySelector('img')).toBeNull();
  expect(within(block).getByText('Output')).toBeDefined();
  expect(within(block).getByText('Script fixture complete')).toBeDefined();
  expect((await axe(block)).violations).toEqual([]);
});

it('shows live Script source before output, then preserves it through completion and failure', () => {
  const source = 'const values = [1, 2, 3]; text(values.map(n => n * 2));';
  const tool: ToolCallInfo = { id: 'script', name: 'exec', input: { raw: source }, status: 'running' };

  const block = renderToolCall(document.body.createDiv(), tool, { initiallyExpanded: true });
  expect(block.querySelector('code')?.textContent).toBe(source);
  expect(within(block).getByText('Running...')).toBeDefined();
  for (const status of ['running', 'completed', 'error'] as const) {
    const updated = { ...tool, status, result: status === 'error' ? 'Script error: fixture failure' : '[2,4,6]' };
    updateToolCallResult(block, updated);
    expect(block.querySelector('code')?.textContent).toBe(source);
    expect(within(block).getByText(updated.result)).toBeDefined();
  }
});

it('lists the tool calls a live Script made once its result arrives', async () => {
  const tool: ToolCallInfo = { id: 'script-calls', name: 'exec', input: { code: 'await tools.fetch({})' }, status: 'running' };

  const block = renderToolCall(document.body.createDiv(), tool, { initiallyExpanded: true });
  expect(within(block).queryByRole('list', { name: 'Tool calls' })).toBeNull();

  updateToolCallResult(block, { ...tool, status: 'completed', result: 'ok', scriptToolCalls: [
    { name: 'Bash', input: { command: 'ls -la' }, status: 'completed', durationMs: 12 },
    { name: 'web_context', input: { query: 'release notes', max_urls: 5 }, status: 'completed' },
    { name: 'fetch', status: 'running' },
    { name: 'search', args: '{"q":"x"}', status: 'cancelled', durationMs: 999.6 },
  ] });
  const calls = within(within(block).getByRole('list', { name: 'Tool calls' })).getAllByRole('listitem');
  // Known tools read like their own headers; other tools list their arguments.
  expect(calls.map(call => call.textContent)).toEqual([
    'Bash ls -la 12ms', 'web_context query: release notes, max_urls: 5', 'fetch', 'search {"q":"x"} 1000ms',
  ]);
  expect(within(calls[2]).getByRole('img', { name: 'Status: running' })).toBeDefined();
  expect(within(calls[3]).getByRole('img', { name: 'Status: cancelled' })).toBeDefined();
  expect((await axe(block)).violations).toEqual([]);
});


describe('file tool card accessible labels', () => {
  const filePath = 'project/src/deeply/nested/folder/with/a-long-name/file.ts';
  const input = { file_path: filePath };

  it.each(['Write', 'Edit'])('gives specialized and generic %s cards the same literal label', async (name) => {
    const tool: ToolCallInfo = { id: `long-${name}`, name, status: 'running', input };
    const parent = document.body.createDiv();
    const specializedLive = createWriteEditBlock(parent, tool).wrapperEl;
    const specializedStored = renderStoredWriteEdit(parent, { ...tool, status: 'completed' });
    const genericLive = renderToolCall(parent, tool);
    const genericStored = renderStoredToolCall(parent, { ...tool, status: 'completed' });

    const expected = `${name}: .../a-long-name/file.ts`;
    const labels = [specializedLive, specializedStored, genericLive, genericStored]
      .map(card => within(card).getByRole('button').getAttribute('aria-label'));
    expect(labels).toEqual([
      `${expected} - click to expand`,
      `${expected} - click to expand`,
      `${expected} - click to expand`,
      `${expected} - click to expand`,
    ]);
    expect(within(specializedStored).getByRole('button', { name: `${expected} - click to expand` })).toBeDefined();
    expect(await axe(parent)).toHaveNoViolations();
  });
});

it('omits silent write_stdin polling cards from the live response while preserving real input', async () => {
  const parent = document.body.createDiv();
  const state = new ChatState();
  state.currentContentEl = parent;
  const stream = new ToolCallStream({
    state, plugin: await createChatFeatureHost(),
    indicator: { show: () => undefined }, getMessagesEl: () => parent, scrollToBottom: () => undefined,
  });
  const message = { id: 'response', role: 'assistant' as const, content: '', timestamp: Date.now(), toolCalls: [] };
  stream.use({ type: 'tool_use', id: 'refined-poll', name: 'unknown', input: {} }, message);
  stream.flush();
  expect(within(parent).getByRole('button', { name: /unknown/ })).toBeDefined();
  stream.use({ type: 'tool_use', id: 'refined-poll', name: 'write_stdin', input: { session_id: 'session', chars: '' } }, message);
  stream.use({ type: 'tool_use', id: 'poll', name: 'write_stdin', input: { session_id: 'session', chars: '' } }, message);
  stream.complete({ type: 'tool_result', id: 'poll', content: 'Still running' }, message);
  stream.use({ type: 'tool_use', id: 'input', name: 'write_stdin', input: { session_id: 'session', chars: 'y\n' } }, message);
  stream.flush();
  expect(within(parent).getByRole('button', { name: /write_stdin: #session y/ })).toBeDefined();
  expect(within(parent).getAllByRole('button')).toHaveLength(1);
  stream.cancelAll();
});


it('localizes pending and settled tool-card status while preserving native output', () => {
  setLocale('zh-CN');
  const tool: ToolCallInfo = { id: 'live', name: 'Bash', input: { command: 'git status' }, status: 'running' };
  const block = renderToolCall(document.body.createDiv(), tool, { initiallyExpanded: true });
  expect(within(block).getByText('运行中…')).toBeDefined();
  expect(within(block).getByLabelText('状态：运行中')).toBeDefined();
  updateToolCallResult(block, { ...tool, status: 'completed', result: 'Working tree clean' });
  expect(within(block).getByLabelText('状态：已完成')).toBeDefined();
  expect(within(block).getByText('Working tree clean')).toBeDefined();
  updateToolCallResult(block, { ...tool, status: 'blocked', result: 'Native denial' });
  expect(within(block).getByLabelText('状态：已阻止')).toBeDefined();
  expect(within(block).getByText('Native denial')).toBeDefined();
});

it.each([false, true])('localizes live and stored write fallbacks (error: %s)', isError => {
  setLocale('zh-CN');
  const tool: ToolCallInfo = { id: 'write', name: 'Write', input: { file_path: 'fixture.md' }, status: 'running' };
  const parent = document.body.createDiv();
  const state = createWriteEditBlock(parent, tool, { initiallyExpanded: true });
  expect(within(state.wrapperEl).getByText('正在写入…')).toBeDefined();
  finalizeWriteEditBlock(state, isError);
  expect(within(state.wrapperEl).getByText(isError ? '错误' : '已完成')).toBeDefined();
  expect(within(state.wrapperEl).getByLabelText(isError ? '状态：错误' : '状态：已完成')).toBeDefined();
  const stored = renderStoredWriteEdit(parent, { ...tool, status: isError ? 'error' : 'completed' }, { initiallyExpanded: true });
  expect(within(stored).getByText(isError ? '错误' : '已完成')).toBeDefined();
});

it('localizes task progress and patch status through their real card consumers', () => {
  setLocale('zh-CN');
  const todo: ToolCallInfo = { id: 'todo', name: 'TodoWrite', status: 'running', input: {
    todos: [{ content: 'Check errors', activeForm: 'Checking errors', status: 'in_progress' }],
  } };
  const block = renderToolCall(document.body.createDiv(), todo, { initiallyExpanded: true });
  expect(within(block).getByText('任务 0/1')).toBeDefined();
  expect(within(block).getAllByText('Checking errors')).not.toHaveLength(0);
  updateToolCallResult(block, { ...todo, status: 'completed' });
  expect(within(block).getByLabelText('状态：进行中')).toBeDefined();
  updateToolCallResult(block, { ...todo, status: 'completed', input: {
    todos: [{ content: 'Check errors', activeForm: 'Checking errors', status: 'completed' }],
  } });
  expect(within(block).getByText('任务 1/1')).toBeDefined();
  expect(within(block).getByLabelText('状态：已完成')).toBeDefined();
  const patch = renderStoredToolCall(document.body.createDiv(), {
    id: 'patch', name: 'apply_patch', status: 'completed', input: {
      patch: '*** Begin Patch\n*** Add File: fixture.md\n+Native contents\n*** End Patch',
    },
  }, { initiallyExpanded: true });
  expect(within(patch).getByLabelText('变更：+1 -0')).toBeDefined();
  expect(within(patch).getByText('Native contents')).toBeDefined();
});


it.each([
  ['Bash', 'Bash: 命令'], ['Glob', 'Glob: 文件'], ['Grep', 'Grep: 匹配模式'],
  ['Skill', 'Skill: 技能'], ['ToolSearch', 'ToolSearch: 工具'],
])('localizes the %s placeholder through its disclosure', (name, label) => {
  setLocale('zh-CN');
  const block = renderToolCall(document.body.createDiv(), { id: 'partial', name, status: 'running', input: {} });
  expect(within(block).getByRole('button', { name: `${label} - 点击展开` })).toBeDefined();
});

it.each([1, 2])('localizes wait summaries for %s agents without changing their IDs', count => {
  setLocale('zh-CN');
  const ids = Array.from({ length: count }, (_, index) => `native-agent-${index}`);
  const tool: ToolCallInfo = { id: 'wait', name: 'wait_agent', status: 'running', input: { ids } };
  const block = renderToolCall(document.body.createDiv(), tool);
  expect(within(block).getByText(`${count} 个代理`)).toBeDefined();
  expect(tool.input.ids).toEqual(ids);
});
