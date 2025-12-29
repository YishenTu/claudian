import type { AskUserQuestionInput } from '../src/core/types';
import { AskUserQuestionPanel } from '../src/ui/components/AskUserQuestionPanel';

type Listener = (event: any) => void;

class MockClassList {
  private classes = new Set<string>();

  add(...items: string[]): void {
    items.forEach((item) => this.classes.add(item));
  }

  remove(...items: string[]): void {
    items.forEach((item) => this.classes.delete(item));
  }

  contains(item: string): boolean {
    return this.classes.has(item);
  }

  has(item: string): boolean {
    return this.classes.has(item);
  }

  toggle(item: string, force?: boolean): void {
    if (force === undefined) {
      if (this.classes.has(item)) {
        this.classes.delete(item);
      } else {
        this.classes.add(item);
      }
      return;
    }
    if (force) {
      this.classes.add(item);
    } else {
      this.classes.delete(item);
    }
  }

  clear(): void {
    this.classes.clear();
  }

  toArray(): string[] {
    return Array.from(this.classes);
  }
}

class MockElement {
  tagName: string;
  classList = new MockClassList();
  style: Record<string, string> = {};
  children: MockElement[] = [];
  attributes: Record<string, string> = {};
  dataset: Record<string, string> = {};
  parent: MockElement | null = null;
  textContent = '';
  value = '';
  type = '';
  placeholder = '';
  private listeners: Record<string, Listener[]> = {};

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  set className(value: string) {
    this.classList.clear();
    value.split(/\s+/).filter(Boolean).forEach((cls) => this.classList.add(cls));
  }

  get className(): string {
    return this.classList.toArray().join(' ');
  }

  set innerHTML(_value: string) {
    this.children = [];
    this.textContent = '';
  }

  appendChild(child: MockElement): MockElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
    if (name.startsWith('data-')) {
      const key = name
        .slice(5)
        .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      this.dataset[key] = value;
    }
  }

  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners[type]) {
      this.listeners[type] = [];
    }
    this.listeners[type].push(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    if (!this.listeners[type]) return;
    this.listeners[type] = this.listeners[type].filter((item) => item !== listener);
  }

  dispatchEvent(event: any): void {
    const listeners = this.listeners[event.type] || [];
    for (const listener of listeners) {
      listener(event);
    }
    if (event.bubbles && this.parent) {
      this.parent.dispatchEvent(event);
    }
  }

  focus(): void {
    const doc = (global as any).document;
    if (doc.activeElement === this) {
      return;
    }
    doc.activeElement = this;
    this.dispatchEvent({ type: 'focus', bubbles: false });
  }

  blur(): void {
    const doc = (global as any).document;
    if (doc.activeElement === this) {
      doc.activeElement = null;
    }
    this.dispatchEvent({ type: 'blur', bubbles: false });
  }

  querySelector(selector: string): MockElement | null {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector: string): MockElement[] {
    const matches: MockElement[] = [];
    const classMatch = selector.match(/\.([a-zA-Z0-9_-]+)/);
    const attrMatch = selector.match(/\[data-([a-zA-Z0-9_-]+)="([^"]+)"\]/);
    const match = (el: MockElement): boolean => {
      if (classMatch && !el.classList.has(classMatch[1])) {
        return false;
      }
      if (attrMatch) {
        const attrName = `data-${attrMatch[1]}`;
        if (el.attributes[attrName] !== attrMatch[2]) {
          return false;
        }
      }
      return true;
    };
    const walk = (el: MockElement) => {
      if (match(el)) {
        matches.push(el);
      }
      for (const child of el.children) {
        walk(child);
      }
    };
    for (const child of this.children) {
      walk(child);
    }
    return matches;
  }
}

function createMockDocument() {
  const listeners: Record<string, Listener[]> = {};
  const body = new MockElement('body');
  return {
    body,
    activeElement: null as MockElement | null,
    createElement: (tag: string) => new MockElement(tag),
    createTextNode: (text: string) => {
      const node = new MockElement('#text');
      node.textContent = text;
      return node;
    },
    addEventListener: (type: string, listener: Listener) => {
      if (!listeners[type]) {
        listeners[type] = [];
      }
      listeners[type].push(listener);
    },
    removeEventListener: (type: string, listener: Listener) => {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter((item) => item !== listener);
    },
    dispatchEvent: (event: any) => {
      const handlers = listeners[event.type] || [];
      handlers.forEach((handler) => handler(event));
    },
  };
}

function createContainer(document: any): MockElement {
  const container = document.createElement('div');
  const inputContainer = document.createElement('div');
  inputContainer.className = 'claudian-input-container';
  const inputWrapper = document.createElement('div');
  inputWrapper.className = 'claudian-input-wrapper';
  inputContainer.appendChild(inputWrapper);
  container.appendChild(inputContainer);
  document.body.appendChild(container);
  return container;
}

function createKeyEvent(key: string, options: { shiftKey?: boolean } = {}) {
  return {
    type: 'keydown',
    key,
    shiftKey: options.shiftKey ?? false,
    preventDefault: jest.fn(),
    stopPropagation: jest.fn(),
  } as any;
}

describe('AskUserQuestionPanel - global keyboard routing', () => {
  it('routes arrow keys to selection even when focus is outside', () => {
    const originalDocument = (global as any).document;
    const mockDocument = createMockDocument();
    (global as any).document = mockDocument;

    const containerEl = createContainer(mockDocument);
    const input: AskUserQuestionInput = {
      questions: [
        {
          question: 'Pick one',
          header: 'Q1',
          multiSelect: false,
          options: [
            { label: 'Option A', description: '' },
            { label: 'Option B', description: '' },
          ],
        },
      ],
    };

    const panel = new AskUserQuestionPanel({} as any, {
      containerEl,
      input,
      onSubmit: jest.fn(),
      onCancel: jest.fn(),
    });

    const outsideEl = mockDocument.createElement('div');
    mockDocument.body.appendChild(outsideEl);
    outsideEl.focus();

    const event = createKeyEvent('ArrowDown');
    mockDocument.dispatchEvent(event);

    const option1 = containerEl.querySelector(
      '.claudian-ask-panel-option[data-option-index="1"]'
    ) as MockElement;

    expect(option1).toBeTruthy();
    expect(option1.classList.contains('focused')).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();

    panel.destroy();
    (global as any).document = originalDocument;
  });

  it('routes Tab to submit tab navigation', () => {
    const originalDocument = (global as any).document;
    const mockDocument = createMockDocument();
    (global as any).document = mockDocument;

    const containerEl = createContainer(mockDocument);
    const input: AskUserQuestionInput = {
      questions: [
        {
          question: 'Pick one',
          header: 'Q1',
          multiSelect: false,
          options: [
            { label: 'Option A', description: '' },
            { label: 'Option B', description: '' },
          ],
        },
      ],
    };

    const panel = new AskUserQuestionPanel({} as any, {
      containerEl,
      input,
      onSubmit: jest.fn(),
      onCancel: jest.fn(),
    });

    const event = createKeyEvent('Tab');
    mockDocument.dispatchEvent(event);

    const submitTab = containerEl.querySelector(
      '.claudian-ask-panel-tab[data-tab-index="1"]'
    ) as MockElement;

    expect(submitTab).toBeTruthy();
    expect(submitTab.classList.contains('active')).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();

    panel.destroy();
    (global as any).document = originalDocument;
  });
});
