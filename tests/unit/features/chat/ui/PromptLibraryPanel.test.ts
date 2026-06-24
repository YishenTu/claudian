import type { PromptLibraryStorage, StoredPrompt } from '@/core/storage/PromptLibraryStorage';
import { PromptLibraryPanel } from '@/features/chat/ui/PromptLibraryPanel';

type Listener = (event: { type: string; [k: string]: unknown }) => void;

// Minimal Obsidian-style element mock covering the panel's render + click path.
class MockElement {
  tagName: string;
  classList = new Set<string>();
  style: Record<string, string> = {};
  children: MockElement[] = [];
  attributes: Record<string, string> = {};
  parent: MockElement | null = null;
  textContent = '';
  value = '';
  private listeners: Record<string, Listener[]> = {};

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  set className(value: string) {
    this.classList = new Set(value.split(/\s+/).filter(Boolean));
  }

  get ownerDocument(): unknown {
    return (globalThis as { document?: unknown }).document;
  }

  addClass(cls: string): void {
    cls.split(/\s+/).filter(Boolean).forEach(c => this.classList.add(c));
  }
  removeClass(cls: string): void {
    cls.split(/\s+/).filter(Boolean).forEach(c => this.classList.delete(c));
  }
  hasClass(cls: string): boolean {
    return this.classList.has(cls);
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  contains(node: unknown): boolean {
    const walk = (el: MockElement): boolean => el === node || el.children.some(walk);
    return this === node || walk(this);
  }

  appendChild(child: MockElement): MockElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  addEventListener(type: string, listener: Listener): void {
    (this.listeners[type] ||= []).push(listener);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners[type] = (this.listeners[type] || []).filter(l => l !== listener);
  }
  dispatchEvent(event: { type: string; [k: string]: unknown }): void {
    for (const l of (this.listeners[event.type] || [])) l(event);
  }
  click(): void {
    this.dispatchEvent({ type: 'click', stopPropagation: jest.fn(), preventDefault: jest.fn() });
  }

  empty(): void {
    this.children = [];
    this.textContent = '';
  }

  private makeChild(tag: string, options?: { cls?: string; text?: string; attr?: Record<string, string> }): MockElement {
    const el = new MockElement(tag);
    if (options?.cls) el.className = options.cls;
    if (options?.text) el.textContent = options.text;
    if (options?.attr) for (const [k, v] of Object.entries(options.attr)) el.setAttribute(k, v);
    this.appendChild(el);
    return el;
  }

  createDiv(options?: { cls?: string; text?: string }): MockElement {
    return this.makeChild('div', options);
  }
  createSpan(options?: { cls?: string; text?: string }): MockElement {
    return this.makeChild('span', options);
  }
  createEl(tag: string, options?: { cls?: string; text?: string; attr?: Record<string, string> }): MockElement {
    return this.makeChild(tag, options);
  }

  querySelector(selector: string): MockElement | null {
    return this.querySelectorAll(selector)[0] || null;
  }
  querySelectorAll(selector: string): MockElement[] {
    const matches: MockElement[] = [];
    const classMatch = selector.match(/\.([a-zA-Z0-9_-]+)/g);
    const want = classMatch ? classMatch.map(c => c.slice(1)) : [];
    const walk = (el: MockElement): void => {
      if (want.length && want.every(c => el.classList.has(c))) matches.push(el);
      for (const c of el.children) walk(c);
    };
    for (const c of this.children) walk(c);
    return matches;
  }
}

function mockStorage(prompts: StoredPrompt[]): jest.Mocked<PromptLibraryStorage> {
  return {
    load: jest.fn().mockResolvedValue(prompts),
    save: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<PromptLibraryStorage>;
}

describe('PromptLibraryPanel', () => {
  let originalDocument: unknown;

  beforeEach(() => {
    originalDocument = (global as { document?: unknown }).document;
    (global as { document?: unknown }).document = {
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };
  });

  afterEach(() => {
    (global as { document?: unknown }).document = originalDocument;
  });

  it('renders a row per loaded prompt and inserts content on click', async () => {
    const prompts: StoredPrompt[] = [
      { id: '1', name: 'Summarize', content: 'Summarize this:', updatedAt: 1 },
    ];
    const onInsert = jest.fn();
    const parent = new MockElement('div');

    const panel = new PromptLibraryPanel(parent as unknown as HTMLElement, {
      storage: mockStorage(prompts),
      onInsert,
      getApp: () => null as never,
    });

    await panel.show();

    const rowBody = parent.querySelector('.claudian-prompt-row-body');
    expect(rowBody).not.toBeNull();
    rowBody!.click();

    expect(onInsert).toHaveBeenCalledWith('Summarize this:');
  });
});
