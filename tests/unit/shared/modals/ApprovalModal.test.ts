import { ApprovalModal } from '@/shared/modals/ApprovalModal';

type Listener = (event: any) => void;

class MockClassList {
  private classes = new Set<string>();

  add(...items: string[]): void {
    items.forEach((item) => this.classes.add(item));
  }

  remove(...items: string[]): void {
    items.forEach((item) => this.classes.delete(item));
  }

  has(item: string): boolean {
    return this.classes.has(item);
  }
}

class MockElement {
  tagName: string;
  classList = new MockClassList();
  children: MockElement[] = [];
  attributes: Record<string, string> = {};
  parent: MockElement | null = null;
  textContent = '';
  private listeners: Record<string, Listener[]> = {};

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  addClass(cls: string): void {
    this.classList.add(cls);
  }

  setText(text: string): void {
    this.textContent = text;
  }

  appendChild(child: MockElement): MockElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  createDiv(options: { cls?: string; text?: string } = {}): MockElement {
    const el = new MockElement('div');
    if (options.cls) {
      options.cls.split(/\s+/).filter(Boolean).forEach((cls) => el.classList.add(cls));
    }
    if (options.text) {
      el.textContent = options.text;
    }
    this.appendChild(el);
    return el;
  }

  createSpan(options: { cls?: string; text?: string } = {}): MockElement {
    const el = new MockElement('span');
    if (options.cls) {
      options.cls.split(/\s+/).filter(Boolean).forEach((cls) => el.classList.add(cls));
    }
    if (options.text) {
      el.textContent = options.text;
    }
    this.appendChild(el);
    return el;
  }

  createEl(
    tag: string,
    options: { cls?: string; text?: string; attr?: Record<string, string> } = {}
  ): MockElement {
    const el = new MockElement(tag);
    if (options.cls) {
      options.cls.split(/\s+/).filter(Boolean).forEach((cls) => el.classList.add(cls));
    }
    if (options.text) {
      el.textContent = options.text;
    }
    if (options.attr) {
      Object.entries(options.attr).forEach(([key, value]) => {
        el.setAttribute(key, value);
      });
    }
    this.appendChild(el);
    return el;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
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
  }

  focus(): void {
    const doc = (global as any).document;
    doc.activeElement = this;
    this.dispatchEvent({ type: 'focus' });
  }

  empty(): void {
    this.children = [];
  }
}

function createMockDocument() {
  const listeners: Record<string, Listener[]> = {};
  return {
    activeElement: null as MockElement | null,
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

function createKeyEvent(key: string, options: { shiftKey?: boolean } = {}) {
  return {
    type: 'keydown',
    key,
    shiftKey: options.shiftKey ?? false,
    preventDefault: jest.fn(),
    stopPropagation: jest.fn(),
  } as any;
}

describe('ApprovalModal - global keyboard navigation', () => {
  it('moves focus with arrow keys and prevents scrolling', () => {
    const originalDocument = (global as any).document;
    const mockDocument = createMockDocument();
    (global as any).document = mockDocument;

    const modal = new ApprovalModal({} as any, 'Tool', {}, 'Desc', jest.fn());
    (modal as any).setTitle = jest.fn();
    (modal as any).contentEl = new MockElement('div');

    ApprovalModal.prototype.onOpen.call(modal);

    const buttons = (modal as any).buttons as MockElement[];
    expect(buttons.length).toBeGreaterThan(1);
    expect(mockDocument.activeElement).toBe(buttons[0]);

    const event = createKeyEvent('ArrowDown');
    mockDocument.dispatchEvent(event);

    expect(mockDocument.activeElement).toBe(buttons[1]);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();

    ApprovalModal.prototype.onClose.call(modal);
    (global as any).document = originalDocument;
  });

  it('resolves cancel when closed without decision', () => {
    const resolve = jest.fn();
    const modal = new ApprovalModal({} as any, 'Tool', {}, 'Desc', resolve);
    (modal as any).contentEl = new MockElement('div');

    ApprovalModal.prototype.onClose.call(modal);

    expect(resolve).toHaveBeenCalledWith('cancel');
  });

  it('renders decisionReason when provided', () => {
    const originalDocument = (global as any).document;
    (global as any).document = createMockDocument();

    const modal = new ApprovalModal({} as any, 'Bash', {}, 'Run command: ls', jest.fn(), {
      decisionReason: 'No matching allow rule',
    });
    (modal as any).setTitle = jest.fn();
    (modal as any).contentEl = new MockElement('div');

    ApprovalModal.prototype.onOpen.call(modal);

    const contentEl = (modal as any).contentEl as MockElement;
    const infoEl = contentEl.children[0]; // .claudian-approval-info
    const reasonEl = infoEl.children.find(
      (el: MockElement) => el.classList.has('claudian-approval-reason')
    );
    expect(reasonEl).toBeDefined();
    expect(reasonEl!.textContent).toBe('No matching allow rule');

    ApprovalModal.prototype.onClose.call(modal);
    (global as any).document = originalDocument;
  });

  it('renders blockedPath when provided', () => {
    const originalDocument = (global as any).document;
    (global as any).document = createMockDocument();

    const modal = new ApprovalModal({} as any, 'Read', {}, 'Read file: /etc/passwd', jest.fn(), {
      blockedPath: '/etc/passwd',
    });
    (modal as any).setTitle = jest.fn();
    (modal as any).contentEl = new MockElement('div');

    ApprovalModal.prototype.onOpen.call(modal);

    const contentEl = (modal as any).contentEl as MockElement;
    const infoEl = contentEl.children[0]; // .claudian-approval-info
    const pathEl = infoEl.children.find(
      (el: MockElement) => el.classList.has('claudian-approval-blocked-path')
    );
    expect(pathEl).toBeDefined();
    expect(pathEl!.textContent).toBe('/etc/passwd');

    ApprovalModal.prototype.onClose.call(modal);
    (global as any).document = originalDocument;
  });

  it('does not render reason or path when not provided', () => {
    const originalDocument = (global as any).document;
    (global as any).document = createMockDocument();

    const modal = new ApprovalModal({} as any, 'Bash', {}, 'Run: ls', jest.fn(), {});
    (modal as any).setTitle = jest.fn();
    (modal as any).contentEl = new MockElement('div');

    ApprovalModal.prototype.onOpen.call(modal);

    const contentEl = (modal as any).contentEl as MockElement;
    const infoEl = contentEl.children[0];
    const reasonEl = infoEl.children.find(
      (el: MockElement) => el.classList.has('claudian-approval-reason')
    );
    const pathEl = infoEl.children.find(
      (el: MockElement) => el.classList.has('claudian-approval-blocked-path')
    );
    expect(reasonEl).toBeUndefined();
    expect(pathEl).toBeUndefined();

    ApprovalModal.prototype.onClose.call(modal);
    (global as any).document = originalDocument;
  });
});
