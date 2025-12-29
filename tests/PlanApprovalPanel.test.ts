import { PlanApprovalPanel } from '../src/ui/components/PlanApprovalPanel';

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
    if (name === 'data-option-index') {
      this.dataset.optionIndex = value;
    }
  }

  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners[type]) {
      this.listeners[type] = [];
    }
    this.listeners[type].push(listener);
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
    const match = (el: MockElement): boolean => {
      const classMatch = selector.match(/\.([a-zA-Z0-9_-]+)/);
      if (classMatch && !el.classList.has(classMatch[1])) {
        return false;
      }
      const attrMatch = selector.match(/\[data-option-index="(\d+)"\]/);
      if (attrMatch && el.attributes['data-option-index'] !== attrMatch[1]) {
        return false;
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
  const body = new MockElement('body');
  return {
    body,
    activeElement: null as MockElement | null,
    createElement: (tag: string) => new MockElement(tag),
  };
}

function createContainer(document: any): MockElement {
  const container = document.createElement('div');
  const inputContainer = document.createElement('div');
  inputContainer.className = 'claudian-input-container';
  const inputWrapper = document.createElement('div');
  inputWrapper.className = 'claudian-input-wrapper';
  const thinking = document.createElement('div');
  thinking.className = 'claudian-thinking';
  inputContainer.appendChild(inputWrapper);
  container.appendChild(inputContainer);
  container.appendChild(thinking);
  document.body.appendChild(container);
  return container;
}

describe('PlanApprovalPanel', () => {
  it('blurs revise input when moving focus to another option', () => {
    const originalDocument = (global as any).document;
    const mockDocument = createMockDocument();
    (global as any).document = mockDocument;
    const containerEl = createContainer(mockDocument);
    const onApprove = jest.fn();
    const onApproveNewSession = jest.fn();
    const onRevise = jest.fn();
    const onCancel = jest.fn();

    new PlanApprovalPanel({} as any, {
      containerEl,
      planContent: 'Plan content',
      component: {} as any,
      onApprove,
      onApproveNewSession,
      onRevise,
      onCancel,
    });

    const reviseInput = containerEl.querySelector('.claudian-plan-approval-revise-inline') as any;
    const option1 = containerEl.querySelector('.claudian-plan-approval-option[data-option-index="1"]') as any;

    expect(reviseInput).toBeTruthy();
    expect(option1).toBeTruthy();

    reviseInput.focus();
    expect(document.activeElement).toBe(reviseInput);

    const hoverEvent = { type: 'mouseenter', bubbles: false };
    option1.dispatchEvent(hoverEvent);

    expect(mockDocument.activeElement).not.toBe(reviseInput);
    expect(option1.classList.contains('focused')).toBe(true);
    (global as any).document = originalDocument;
  });
});
