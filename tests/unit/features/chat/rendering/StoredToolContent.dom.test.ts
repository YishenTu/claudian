/** @jest-environment jsdom */

import { fireEvent, within } from '@testing-library/dom';
import { axe } from 'jest-axe';

import type { ToolCallInfo } from '@/core/types';
import {
  renderStoredToolCall,
  renderToolCall,
  updateToolCallResult,
} from '@/features/chat/rendering/ToolCallRenderer';
import { renderStoredWriteEdit } from '@/features/chat/rendering/WriteEditRenderer';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
HTMLElement.prototype.toggleClass = function (classes, enabled) {
  for (const cls of typeof classes === 'string' ? [classes] : classes) {
    this.classList.toggle(cls, enabled);
  }
};

beforeEach(() => {
  document.body.replaceChildren();
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

it('keeps running stored tools and live result updates eager', () => {
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

  const liveElements = new Map<string, HTMLElement>();
  const live = renderToolCall(parent, tool, liveElements);
  tool.status = 'completed';
  tool.result = 'finished output';
  updateToolCallResult(tool.id, tool, liveElements);
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
