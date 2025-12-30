import { setIcon } from 'obsidian';

import {
  createAsyncSubagentBlock,
  finalizeAsyncSubagent,
  markAsyncSubagentOrphaned,
  updateAsyncSubagentRunning,
} from '@/ui/renderers/SubagentRenderer';

interface MockElement {
  children: MockElement[];
  addClass: (cls: string) => void;
  removeClass: (cls: string) => void;
  hasClass: (cls: string) => boolean;
  getClasses: () => string[];
  addEventListener: (event: string, handler: (e: any) => void) => void;
  dispatchEvent: (event: { type: string; target?: any }) => void;
  click: () => void;
  createDiv: (opts?: { cls?: string; text?: string }) => MockElement;
  createSpan: (opts?: { cls?: string; text?: string }) => MockElement;
  createEl: (tag: string, opts?: { cls?: string; text?: string }) => MockElement;
  setText: (text: string) => void;
  textContent: string;
  dataset: Record<string, string>;
  style: Record<string, string>;
  empty: () => void;
  setAttribute: (name: string, value: string) => void;
  getAttribute: (name: string) => string | null;
}

function createMockElement(tag = 'div'): MockElement {
  const children: MockElement[] = [];
  const classList = new Set<string>();
  const dataset: Record<string, string> = {};
  const style: Record<string, string> = {};
  const attributes: Map<string, string> = new Map();
  const eventListeners: Map<string, Array<(e: any) => void>> = new Map();
  let textContent = '';

  const element: MockElement = {
    children,
    dataset,
    style,
    addClass: (cls: string) => {
      cls.split(/\s+/).filter(Boolean).forEach((c) => classList.add(c));
    },
    removeClass: (cls: string) => {
      cls.split(/\s+/).filter(Boolean).forEach((c) => classList.delete(c));
    },
    hasClass: (cls: string) => classList.has(cls),
    getClasses: () => Array.from(classList),
    addEventListener: (event: string, handler: (e: any) => void) => {
      if (!eventListeners.has(event)) {
        eventListeners.set(event, []);
      }
      eventListeners.get(event)!.push(handler);
    },
    dispatchEvent: (event) => {
      const handlers = eventListeners.get(event.type) || [];
      handlers.forEach((h) => h(event));
    },
    click: () => {
      const handlers = eventListeners.get('click') || [];
      handlers.forEach((h) => h({ type: 'click', target: element, stopPropagation: () => {} }));
    },
    createDiv: (opts) => {
      const child = createMockElement('div');
      if (opts?.cls) child.addClass(opts.cls);
      if (opts?.text) child.setText(opts.text);
      children.push(child);
      return child;
    },
    createSpan: (opts) => {
      const child = createMockElement('span');
      if (opts?.cls) child.addClass(opts.cls);
      if (opts?.text) child.setText(opts.text);
      children.push(child);
      return child;
    },
    createEl: (_tag, opts) => {
      const child = createMockElement(_tag);
      if (opts?.cls) child.addClass(opts.cls);
      if (opts?.text) child.setText(opts.text);
      children.push(child);
      return child;
    },
    setText: (text: string) => {
      textContent = text;
    },
    get textContent() {
      return textContent;
    },
    set textContent(value: string) {
      textContent = value;
    },
    empty: () => {
      children.length = 0;
    },
    setAttribute: (name: string, value: string) => {
      attributes.set(name, value);
    },
    getAttribute: (name: string) => {
      return attributes.get(name) ?? null;
    },
  };

  return element;
}

const getTextByClass = (el: MockElement, cls: string): string[] => {
  const results: string[] = [];
  const visit = (node: MockElement) => {
    if (node.hasClass(cls)) {
      results.push(node.textContent);
    }
    node.children.forEach(visit);
  };
  visit(el);
  return results;
};

describe('Async Subagent Renderer', () => {
  let parentEl: MockElement;

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockElement('div');
  });

  it('shows label immediately and running status text', () => {
    const state = createAsyncSubagentBlock(parentEl as any, 'task-1', { description: 'Background job' });

    expect(state.labelEl.textContent).toBe('Background job');
    expect(state.statusTextEl.textContent).toBe('Running');
    expect((state.wrapperEl as any).getClasses()).toEqual(expect.arrayContaining(['async', 'pending']));
  });

  it('shows agent id in content and keeps label visible while running', () => {
    const state = createAsyncSubagentBlock(parentEl as any, 'task-2', { description: 'Background job' });

    updateAsyncSubagentRunning(state, 'agent-xyz');

    expect(state.labelEl.textContent).toBe('Background job');
    expect(state.statusTextEl.textContent).toBe('Running');
    const contentText = getTextByClass(state.contentEl as any, 'claudian-subagent-done-text')[0];
    expect(contentText).toContain('agent-xyz');
    expect((state.wrapperEl as any).getClasses()).toEqual(expect.arrayContaining(['running', 'async']));
  });

  it('finalizes to completed and reveals description', () => {
    const state = createAsyncSubagentBlock(parentEl as any, 'task-3', { description: 'Background job' });
    updateAsyncSubagentRunning(state, 'agent-complete');

    (setIcon as jest.Mock).mockClear();
    finalizeAsyncSubagent(state, 'all done', false);

    expect(state.labelEl.textContent).toBe('Background job');
    expect(state.statusTextEl.textContent).toBe('Completed');
    expect((state.wrapperEl as any).hasClass('done')).toBe(true);
    const contentText = getTextByClass(state.contentEl as any, 'claudian-subagent-done-text')[0];
    expect(contentText).toBe('DONE');
    const lastIcon = (setIcon as jest.Mock).mock.calls.pop();
    expect(lastIcon?.[1]).toBe('check');
  });

  it('finalizes to error and truncates error message', () => {
    const state = createAsyncSubagentBlock(parentEl as any, 'task-4', { description: 'Background job' });
    updateAsyncSubagentRunning(state, 'agent-error');

    (setIcon as jest.Mock).mockClear();
    finalizeAsyncSubagent(state, 'failure happened', true);

    expect(state.statusTextEl.textContent).toBe('Error');
    expect((state.wrapperEl as any).hasClass('error')).toBe(true);
    const contentText = getTextByClass(state.contentEl as any, 'claudian-subagent-done-text')[0];
    expect(contentText).toContain('ERROR');
    const lastIcon = (setIcon as jest.Mock).mock.calls.pop();
    expect(lastIcon?.[1]).toBe('x');
  });

  it('marks async subagent as orphaned', () => {
    const state = createAsyncSubagentBlock(parentEl as any, 'task-5', { description: 'Background job' });

    markAsyncSubagentOrphaned(state);

    expect(state.statusTextEl.textContent).toBe('Orphaned');
    expect((state.wrapperEl as any).hasClass('orphaned')).toBe(true);
    const contentText = getTextByClass(state.contentEl as any, 'claudian-subagent-done-text')[0];
    expect(contentText).toContain('Task orphaned');
  });
});
