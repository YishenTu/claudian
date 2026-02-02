import type { TodoItem } from '@/core/tools';
import { StatusPanel } from '@/features/chat/ui/StatusPanel';

// Mock obsidian
jest.mock('obsidian', () => ({
  setIcon: jest.fn((el: any, iconName: string) => {
    el.setAttribute('data-icon', iconName);
  }),
  Notice: jest.fn(),
}));

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
  private _scrollTop = 0;
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

  get scrollHeight(): number {
    return 1000;
  }

  get scrollTop(): number {
    return this._scrollTop;
  }

  set scrollTop(_value: number) {
    this._scrollTop = _value;
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
  }

  getAttribute(name: string): string | null {
    // Check attributes first
    if (this.attributes[name] !== undefined) {
      return this.attributes[name];
    }
    // For data-* attributes, also check dataset
    if (name.startsWith('data-')) {
      const dataKey = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return this.dataset[dataKey] ?? null;
    }
    return null;
  }

  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners[type]) {
      this.listeners[type] = [];
    }
    this.listeners[type].push(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    if (!this.listeners[type]) return;
    this.listeners[type] = this.listeners[type].filter((l) => l !== listener);
  }

  dispatchEvent(event: any): void {
    const listeners = this.listeners[event.type] || [];
    for (const listener of listeners) {
      listener(event);
    }
  }

  click(): void {
    this.dispatchEvent({ type: 'click', stopPropagation: jest.fn(), preventDefault: jest.fn() });
  }

  empty(): void {
    this.children = [];
    this.textContent = '';
  }

  // Obsidian-style helper methods
  createDiv(options?: { cls?: string; text?: string }): MockElement {
    const el = new MockElement('div');
    if (options?.cls) el.className = options.cls;
    if (options?.text) el.textContent = options.text;
    this.appendChild(el);
    return el;
  }

  createSpan(options?: { cls?: string; text?: string }): MockElement {
    const el = new MockElement('span');
    if (options?.cls) el.className = options.cls;
    if (options?.text) el.textContent = options.text;
    this.appendChild(el);
    return el;
  }

  setText(text: string): void {
    this.textContent = text;
  }

  querySelector(selector: string): MockElement | null {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector: string): MockElement[] {
    const matches: MockElement[] = [];
    const match = (el: MockElement): boolean => {
      // Handle attribute selectors like [data-panel-subagent-id]
      const attrMatch = selector.match(/\[([a-zA-Z0-9_-]+)\]/);
      if (attrMatch) {
        const attrName = attrMatch[1];
        // Convert data-* attributes to dataset keys (data-panel-subagent-id -> panelSubagentId)
        if (attrName.startsWith('data-')) {
          const dataKey = attrName.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          return el.dataset[dataKey] !== undefined;
        }
        return el.attributes[attrName] !== undefined;
      }

      // Handle class selectors like .claudian-status-panel
      const classMatch = selector.match(/\.([a-zA-Z0-9_-]+)/g);
      if (classMatch) {
        for (const cls of classMatch) {
          const className = cls.slice(1);
          if (!el.classList.has(className)) {
            return false;
          }
        }
      }
      return classMatch !== null;
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
  return {
    createElement: (tag: string) => new MockElement(tag),
  };
}

describe('StatusPanel', () => {
  let containerEl: MockElement;
  let panel: StatusPanel;
  let originalDocument: any;
  let originalNavigator: any;
  let writeTextMock: jest.Mock;

  beforeEach(() => {
    originalDocument = (global as any).document;
    originalNavigator = (global as any).navigator;
    (global as any).document = createMockDocument();
    writeTextMock = jest.fn().mockResolvedValue(undefined);
    (global as any).navigator = { clipboard: { writeText: writeTextMock } };
    containerEl = new MockElement('div');
    panel = new StatusPanel();
  });

  afterEach(() => {
    panel.destroy();
    (global as any).document = originalDocument;
    (global as any).navigator = originalNavigator;
  });

  describe('mount', () => {
    it('should create panel element when mounted', () => {
      panel.mount(containerEl as unknown as HTMLElement);

      expect(containerEl.querySelector('.claudian-status-panel')).not.toBeNull();
    });

    it('should create hidden todo container initially', () => {
      panel.mount(containerEl as unknown as HTMLElement);

      const todoContainer = containerEl.querySelector('.claudian-status-panel-todos');
      expect(todoContainer).not.toBeNull();
      expect(todoContainer!.style.display).toBe('none');
    });
  });

  describe('updateTodos', () => {
    beforeEach(() => {
      panel.mount(containerEl as unknown as HTMLElement);
    });

    it('should show panel when todos are provided', () => {
      const todos: TodoItem[] = [
        { content: 'Task 1', status: 'pending', activeForm: 'Doing Task 1' },
      ];

      panel.updateTodos(todos);

      const todoContainer = containerEl.querySelector('.claudian-status-panel-todos');
      expect(todoContainer!.style.display).toBe('block');
    });

    it('should hide panel when todos is null', () => {
      const todos: TodoItem[] = [
        { content: 'Task 1', status: 'pending', activeForm: 'Doing Task 1' },
      ];

      panel.updateTodos(todos);
      panel.updateTodos(null);

      const todoContainer = containerEl.querySelector('.claudian-status-panel-todos');
      expect(todoContainer!.style.display).toBe('none');
    });

    it('should hide panel when todos is empty array', () => {
      const todos: TodoItem[] = [
        { content: 'Task 1', status: 'pending', activeForm: 'Doing Task 1' },
      ];

      panel.updateTodos(todos);
      panel.updateTodos([]);

      const todoContainer = containerEl.querySelector('.claudian-status-panel-todos');
      expect(todoContainer!.style.display).toBe('none');
    });

    it('should display correct task count', () => {
      const todos: TodoItem[] = [
        { content: 'Task 1', status: 'completed', activeForm: 'Doing Task 1' },
        { content: 'Task 2', status: 'pending', activeForm: 'Doing Task 2' },
        { content: 'Task 3', status: 'in_progress', activeForm: 'Working on Task 3' },
      ];

      panel.updateTodos(todos);

      const label = containerEl.querySelector('.claudian-status-panel-label');
      expect(label?.textContent).toBe('Tasks (1/3)');
    });

    it('should show current task in collapsed header', () => {
      const todos: TodoItem[] = [
        { content: 'Task 1', status: 'pending', activeForm: 'Doing Task 1' },
        { content: 'Task 2', status: 'in_progress', activeForm: 'Working on Task 2' },
      ];

      panel.updateTodos(todos);

      const current = containerEl.querySelector('.claudian-status-panel-current');
      expect(current?.textContent).toBe('Working on Task 2');
    });

    it('should render all todo items in content area', () => {
      const todos: TodoItem[] = [
        { content: 'Task 1', status: 'pending', activeForm: 'Doing Task 1' },
        { content: 'Task 2', status: 'completed', activeForm: 'Doing Task 2' },
      ];

      panel.updateTodos(todos);

      const items = containerEl.querySelectorAll('.claudian-todo-item');
      expect(items.length).toBe(2);
    });

    it('should apply correct status classes to items', () => {
      const todos: TodoItem[] = [
        { content: 'Task 1', status: 'pending', activeForm: 'Task 1' },
        { content: 'Task 2', status: 'in_progress', activeForm: 'Task 2' },
        { content: 'Task 3', status: 'completed', activeForm: 'Task 3' },
      ];

      panel.updateTodos(todos);

      expect(containerEl.querySelector('.claudian-todo-pending')).not.toBeNull();
      expect(containerEl.querySelector('.claudian-todo-in_progress')).not.toBeNull();
      expect(containerEl.querySelector('.claudian-todo-completed')).not.toBeNull();
    });

    it('should handle updateTodos called before mount with todos to display', () => {
      const unmountedPanel = new StatusPanel();

      // Should not throw, just silently handle unmounted state
      expect(() => {
        unmountedPanel.updateTodos([{ content: 'Task', status: 'pending', activeForm: 'Task' }]);
      }).not.toThrow();
    });

    it('should handle updateTodos called with null before mount', () => {
      const unmountedPanel = new StatusPanel();

      // Should not throw
      expect(() => {
        unmountedPanel.updateTodos(null);
      }).not.toThrow();
    });
  });

  describe('toggle', () => {
    beforeEach(() => {
      panel.mount(containerEl as unknown as HTMLElement);
      panel.updateTodos([
        { content: 'Task 1', status: 'in_progress', activeForm: 'Doing Task 1' },
      ]);
    });

    it('should expand content on header click', () => {
      const header = containerEl.querySelector('.claudian-status-panel-header');
      const content = containerEl.querySelector('.claudian-status-panel-content');

      expect(content!.style.display).toBe('none');

      header!.click();

      expect(content!.style.display).toBe('block');
    });

    it('should collapse content on second click', () => {
      const header = containerEl.querySelector('.claudian-status-panel-header');
      const content = containerEl.querySelector('.claudian-status-panel-content');

      header!.click();
      expect(content!.style.display).toBe('block');

      header!.click();
      expect(content!.style.display).toBe('none');
    });

    it('should show list icon in header', () => {
      const icon = containerEl.querySelector('.claudian-status-panel-icon');
      expect(icon).not.toBeNull();
      expect(icon?.getAttribute('data-icon')).toBe('list-checks');
    });

    it('should hide current task when expanded', () => {
      const header = containerEl.querySelector('.claudian-status-panel-header');

      expect(containerEl.querySelector('.claudian-status-panel-current')).not.toBeNull();

      header!.click();

      expect(containerEl.querySelector('.claudian-status-panel-current')).toBeNull();
    });

    it('should toggle on Enter key', () => {
      const header = containerEl.querySelector('.claudian-status-panel-header');
      const content = containerEl.querySelector('.claudian-status-panel-content');

      const event = { type: 'keydown', key: 'Enter', preventDefault: jest.fn() };
      header!.dispatchEvent(event);

      expect(content!.style.display).toBe('block');
      expect(event.preventDefault).toHaveBeenCalled();
    });

    it('should toggle on Space key', () => {
      const header = containerEl.querySelector('.claudian-status-panel-header');
      const content = containerEl.querySelector('.claudian-status-panel-content');

      const event = { type: 'keydown', key: ' ', preventDefault: jest.fn() };
      header!.dispatchEvent(event);

      expect(content!.style.display).toBe('block');
      expect(event.preventDefault).toHaveBeenCalled();
    });

    it('should not toggle on other keys', () => {
      const header = containerEl.querySelector('.claudian-status-panel-header');
      const content = containerEl.querySelector('.claudian-status-panel-content');

      const event = { type: 'keydown', key: 'Tab', preventDefault: jest.fn() };
      header!.dispatchEvent(event);

      expect(content!.style.display).toBe('none');
      expect(event.preventDefault).not.toHaveBeenCalled();
    });
  });

  describe('accessibility', () => {
    beforeEach(() => {
      panel.mount(containerEl as unknown as HTMLElement);
    });

    it('should set tabindex on header', () => {
      const header = containerEl.querySelector('.claudian-status-panel-header');
      expect(header?.getAttribute('tabindex')).toBe('0');
    });

    it('should set role button on header', () => {
      const header = containerEl.querySelector('.claudian-status-panel-header');
      expect(header?.getAttribute('role')).toBe('button');
    });

    it('should update aria-expanded on toggle', () => {
      panel.updateTodos([{ content: 'Task', status: 'pending', activeForm: 'Task' }]);
      const header = containerEl.querySelector('.claudian-status-panel-header');

      expect(header!.getAttribute('aria-expanded')).toBe('false');

      header!.click();
      expect(header!.getAttribute('aria-expanded')).toBe('true');

      header!.click();
      expect(header!.getAttribute('aria-expanded')).toBe('false');
    });

    it('should set descriptive aria-label', () => {
      panel.updateTodos([
        { content: 'Task 1', status: 'completed', activeForm: 'Task 1' },
        { content: 'Task 2', status: 'pending', activeForm: 'Task 2' },
      ]);

      const header = containerEl.querySelector('.claudian-status-panel-header');
      expect(header?.getAttribute('aria-label')).toBe('Expand task list - 1 of 2 completed');
    });

    it('should hide status icons from screen readers', () => {
      panel.updateTodos([{ content: 'Task', status: 'pending', activeForm: 'Task' }]);

      const icon = containerEl.querySelector('.claudian-todo-status-icon');
      expect(icon?.getAttribute('aria-hidden')).toBe('true');
    });
  });

  describe('remount', () => {
    it('should re-create panel structure after remount', () => {
      panel.mount(containerEl as unknown as HTMLElement);

      panel.updateTodos([
        { content: 'Task 1', status: 'completed', activeForm: 'Doing Task 1' },
        { content: 'Task 2', status: 'in_progress', activeForm: 'Doing Task 2' },
      ]);

      panel.remount();

      expect(containerEl.querySelector('.claudian-status-panel')).not.toBeNull();
      const label = containerEl.querySelector('.claudian-status-panel-label');
      expect(label?.textContent).toBe('Tasks (1/2)');
    });

    it('should re-render subagents after remount', () => {
      panel.mount(containerEl as unknown as HTMLElement);

      panel.updateSubagent({ id: 'task-1', description: 'Running task', status: 'running' });

      panel.remount();

      const subagentsEl = containerEl.querySelector('.claudian-status-panel-subagents');
      expect((subagentsEl as any)?.style?.display).toBe('block');
    });

    it('should not throw when called without mount', () => {
      const unmountedPanel = new StatusPanel();
      expect(() => unmountedPanel.remount()).not.toThrow();
    });

    it('should clean up event listeners before remounting', () => {
      panel.mount(containerEl as unknown as HTMLElement);
      panel.updateTodos([
        { content: 'Task 1', status: 'in_progress', activeForm: 'Doing Task 1' },
      ]);

      const header = containerEl.querySelector('.claudian-status-panel-header');
      header!.click();

      panel.remount();

      const content = containerEl.querySelector('.claudian-status-panel-content');
      expect(content!.style.display).toBe('none');
    });
  });

  describe('removeSubagent', () => {
    beforeEach(() => {
      panel.mount(containerEl as unknown as HTMLElement);
    });

    it('should remove a subagent by id', () => {
      panel.updateSubagent({ id: 'task-1', description: 'Task 1', status: 'running' });
      panel.updateSubagent({ id: 'task-2', description: 'Task 2', status: 'running' });

      panel.removeSubagent('task-1');

      const runningText = containerEl.querySelector('.claudian-status-panel-running-text');
      expect(runningText?.textContent).toBe('1 background task');
    });

    it('should hide container when last subagent is removed', () => {
      panel.updateSubagent({ id: 'task-1', description: 'Task 1', status: 'running' });

      panel.removeSubagent('task-1');

      const subagentsEl = containerEl.querySelector('.claudian-status-panel-subagents');
      expect((subagentsEl as any)?.style?.display).toBe('none');
    });
  });

  describe('completion status icon', () => {
    beforeEach(() => {
      panel.mount(containerEl as unknown as HTMLElement);
    });

    it('should show check icon when all todos are completed', () => {
      panel.updateTodos([
        { content: 'Task 1', status: 'completed', activeForm: 'Task 1' },
        { content: 'Task 2', status: 'completed', activeForm: 'Task 2' },
      ]);

      const status = containerEl.querySelector('.status-completed');
      expect(status).not.toBeNull();
      expect(status?.getAttribute('data-icon')).toBe('check');
    });

    it('should not show check icon when some todos are incomplete', () => {
      panel.updateTodos([
        { content: 'Task 1', status: 'completed', activeForm: 'Task 1' },
        { content: 'Task 2', status: 'pending', activeForm: 'Task 2' },
      ]);

      const status = containerEl.querySelector('.status-completed');
      expect(status).toBeNull();
    });
  });

  describe('truncateDescription', () => {
    beforeEach(() => {
      panel.mount(containerEl as unknown as HTMLElement);
    });

    it('should truncate long subagent descriptions', () => {
      const longDescription = 'A'.repeat(60);
      panel.updateSubagent({ id: 'task-1', description: longDescription, status: 'completed' });

      const doneText = containerEl.querySelector('.claudian-status-panel-done-text');
      expect(doneText?.textContent).toContain('...');
      expect(doneText!.textContent!.length).toBeLessThan(longDescription.length);
    });

    it('should not truncate short descriptions', () => {
      const shortDescription = 'Short task';
      panel.updateSubagent({ id: 'task-1', description: shortDescription, status: 'completed' });

      const doneText = containerEl.querySelector('.claudian-status-panel-done-text');
      expect(doneText?.textContent).toBe(shortDescription);
    });
  });

  describe('destroy', () => {
    it('should remove panel from DOM', () => {
      panel.mount(containerEl as unknown as HTMLElement);

      expect(containerEl.querySelector('.claudian-status-panel')).not.toBeNull();

      panel.destroy();

      expect(containerEl.querySelector('.claudian-status-panel')).toBeNull();
    });

    it('should be safe to call multiple times', () => {
      panel.mount(containerEl as unknown as HTMLElement);

      expect(() => {
        panel.destroy();
        panel.destroy();
      }).not.toThrow();
    });

    it('should handle destroy without mount', () => {
      const unmountedPanel = new StatusPanel();

      expect(() => {
        unmountedPanel.destroy();
      }).not.toThrow();
    });
  });

  describe('updateSubagent', () => {
    beforeEach(() => {
      panel.mount(containerEl as unknown as HTMLElement);
    });

    it('should show container when subagent is added', () => {
      panel.updateSubagent({ id: 'task-1', description: 'New task', status: 'pending' });

      const containerEl2 = containerEl.querySelector('.claudian-status-panel-subagents');
      expect((containerEl2 as any)?.style?.display).toBe('block');
    });

    it('should show done row when status changes to completed', () => {
      panel.updateSubagent({ id: 'task-1', description: 'Task', status: 'pending' });
      panel.updateSubagent({ id: 'task-1', description: 'Task', status: 'completed' });

      const doneRow = containerEl.querySelector('.claudian-status-panel-done-row');
      expect(doneRow).toBeDefined();
      const doneText = containerEl.querySelector('.claudian-status-panel-done-text');
      expect(doneText?.textContent).toBe('Task');
    });

    it('should show running row for running status', () => {
      panel.updateSubagent({ id: 'task-1', description: 'Task', status: 'running' });

      const runningRow = containerEl.querySelector('.claudian-status-panel-running-row');
      expect(runningRow).toBeDefined();
      const runningText = containerEl.querySelector('.claudian-status-panel-running-text');
      expect(runningText?.textContent).toBe('1 background task');
    });

    it('should count pending as running', () => {
      panel.updateSubagent({ id: 'task-1', description: 'Task', status: 'pending' });

      const runningText = containerEl.querySelector('.claudian-status-panel-running-text');
      expect(runningText?.textContent).toBe('1 background task');
    });

    it('should not show orphaned subagents', () => {
      panel.updateSubagent({ id: 'task-1', description: 'Task', status: 'orphaned' });

      // Orphaned subagents don't show in panel
      const subagentsEl = containerEl.querySelector('.claudian-status-panel-subagents');
      expect((subagentsEl as any)?.style?.display).toBe('none');
    });

    it('should not show error subagents', () => {
      panel.updateSubagent({ id: 'task-1', description: 'Task', status: 'error' });

      // Error subagents don't show in panel
      const subagentsEl = containerEl.querySelector('.claudian-status-panel-subagents');
      expect((subagentsEl as any)?.style?.display).toBe('none');
    });

    it('should handle updateSubagent called before mount', () => {
      const unmountedPanel = new StatusPanel();

      expect(() => {
        unmountedPanel.updateSubagent({ id: 'task-1', description: 'Task', status: 'pending' });
      }).not.toThrow();
    });
  });

  describe('subagent status display', () => {
    beforeEach(() => {
      panel.mount(containerEl as unknown as HTMLElement);
    });

    it('should show container when subagents are added', () => {
      panel.updateSubagent({ id: 'task-1', description: 'Task', status: 'running' });

      const subagentsEl = containerEl.querySelector('.claudian-status-panel-subagents');
      expect((subagentsEl as any)?.style?.display).toBe('block');
    });

    it('should hide container when no subagents', () => {
      // Clear any subagents
      panel.clearSubagents();

      const subagentsEl = containerEl.querySelector('.claudian-status-panel-subagents');
      expect((subagentsEl as any)?.style?.display).toBe('none');
    });

    it('should show done rows for completed and running row for running', () => {
      panel.updateSubagent({ id: 'task-1', description: 'Task 1', status: 'running' });
      panel.updateSubagent({ id: 'task-2', description: 'Task 2', status: 'running' });
      panel.updateSubagent({ id: 'task-3', description: 'Task 3', status: 'completed' });

      const doneRows = containerEl.querySelectorAll('.claudian-status-panel-done-row');
      expect(doneRows).toHaveLength(1);

      const runningText = containerEl.querySelector('.claudian-status-panel-running-text');
      expect(runningText?.textContent).toBe('2 background tasks');
    });

    it('should update display when subagent status changes', () => {
      panel.updateSubagent({ id: 'task-1', description: 'Task 1', status: 'running' });

      // Check running row exists
      let runningText = containerEl.querySelector('.claudian-status-panel-running-text');
      expect(runningText?.textContent).toBe('1 background task');

      // Change to completed
      panel.updateSubagent({ id: 'task-1', description: 'Task 1', status: 'completed' });

      // Running row should be gone, done row should exist
      runningText = containerEl.querySelector('.claudian-status-panel-running-text');
      expect(runningText).toBeNull();

      const doneText = containerEl.querySelector('.claudian-status-panel-done-text');
      expect(doneText?.textContent).toBe('Task 1');
    });
  });

  describe('clearTerminalSubagents', () => {
    it('should remove completed subagents but keep running ones', () => {
      panel.mount(containerEl as unknown as HTMLElement);

      // Add a running and a completed subagent
      panel.updateSubagent({ id: 'running-1', description: 'Running task', status: 'running' });
      panel.updateSubagent({ id: 'completed-1', description: 'Completed task', status: 'completed' });
      panel.updateSubagent({ id: 'error-1', description: 'Error task', status: 'error' });

      panel.clearTerminalSubagents();

      // Check only running row remains
      const doneRows = containerEl.querySelectorAll('.claudian-status-panel-done-row');
      expect(doneRows).toHaveLength(0);

      const runningText = containerEl.querySelector('.claudian-status-panel-running-text');
      expect(runningText?.textContent).toBe('1 background task');
    });

    it('should remove orphaned subagents', () => {
      panel.mount(containerEl as unknown as HTMLElement);

      panel.updateSubagent({ id: 'orphaned-1', description: 'Orphaned task', status: 'orphaned' });
      panel.updateSubagent({ id: 'pending-1', description: 'Pending task', status: 'pending' });

      panel.clearTerminalSubagents();

      // Check only running row remains (pending counts as running)
      const runningText = containerEl.querySelector('.claudian-status-panel-running-text');
      expect(runningText?.textContent).toBe('1 background task');
    });
  });

  describe('areAllSubagentsCompleted', () => {
    beforeEach(() => {
      panel.mount(containerEl as unknown as HTMLElement);
    });

    it('should return false when no subagents', () => {
      expect(panel.areAllSubagentsCompleted()).toBe(false);
    });

    it('should return true when all subagents are completed', () => {
      panel.updateSubagent({ id: 'task-1', description: 'Task 1', status: 'completed' });
      panel.updateSubagent({ id: 'task-2', description: 'Task 2', status: 'completed' });

      expect(panel.areAllSubagentsCompleted()).toBe(true);
    });

    it('should return false when any subagent is pending', () => {
      panel.updateSubagent({ id: 'task-1', description: 'Task 1', status: 'completed' });
      panel.updateSubagent({ id: 'task-2', description: 'Task 2', status: 'pending' });

      expect(panel.areAllSubagentsCompleted()).toBe(false);
    });

    it('should return false when any subagent is running', () => {
      panel.updateSubagent({ id: 'task-1', description: 'Task 1', status: 'completed' });
      panel.updateSubagent({ id: 'task-2', description: 'Task 2', status: 'running' });

      expect(panel.areAllSubagentsCompleted()).toBe(false);
    });

    it('should return false when any subagent has error', () => {
      panel.updateSubagent({ id: 'task-1', description: 'Task 1', status: 'completed' });
      panel.updateSubagent({ id: 'task-2', description: 'Task 2', status: 'error' });

      expect(panel.areAllSubagentsCompleted()).toBe(false);
    });

    it('should return false when any subagent is orphaned', () => {
      panel.updateSubagent({ id: 'task-1', description: 'Task 1', status: 'completed' });
      panel.updateSubagent({ id: 'task-2', description: 'Task 2', status: 'orphaned' });

      expect(panel.areAllSubagentsCompleted()).toBe(false);
    });

    it('should return true for single completed subagent', () => {
      panel.updateSubagent({ id: 'task-1', description: 'Task 1', status: 'completed' });

      expect(panel.areAllSubagentsCompleted()).toBe(true);
    });
  });

  describe('bash outputs', () => {
    beforeEach(() => {
      panel.mount(containerEl as unknown as HTMLElement);
    });

    it('should render bash section with header and entries', () => {
      panel.addBashOutput({
        id: 'bash-1',
        command: 'echo hello',
        status: 'completed',
        output: 'hello',
        exitCode: 0,
      });

      const bashContainer = containerEl.querySelector('.claudian-status-panel-bash');
      expect(bashContainer).not.toBeNull();
      expect(bashContainer!.style.display).toBe('block');

      const header = containerEl.querySelector('.claudian-status-panel-bash-header');
      expect(header).not.toBeNull();
      const label = header!.querySelector('.claudian-tool-label');
      expect(label).not.toBeNull();
      expect(label!.textContent).toBe('Command panel');

      const entries = containerEl.querySelectorAll('.claudian-status-panel-bash-entry');
      expect(entries.length).toBe(1);
    });

    it('should collapse and expand the bash section', () => {
      panel.addBashOutput({
        id: 'bash-1',
        command: 'echo hello',
        status: 'completed',
        output: 'hello',
        exitCode: 0,
      });

      const content = containerEl.querySelector('.claudian-status-panel-bash-content');
      expect(content).not.toBeNull();
      expect(content!.style.display).toBe('block');

      const header = containerEl.querySelector('.claudian-status-panel-bash-header');
      expect(header).not.toBeNull();
      const label = header!.querySelector('.claudian-tool-label');
      expect(label).not.toBeNull();
      expect(label!.textContent).toBe('Command panel');

      header!.click();
      expect(content!.style.display).toBe('none');
      const collapsedHeader = containerEl.querySelector('.claudian-status-panel-bash-header');
      expect(collapsedHeader).not.toBeNull();
      const collapsedLabel = collapsedHeader!.querySelector('.claudian-tool-label');
      expect(collapsedLabel).not.toBeNull();
      expect(collapsedLabel!.textContent).toBe('echo hello');

      header!.click();
      expect(content!.style.display).toBe('block');
      const expandedHeaderAgain = containerEl.querySelector('.claudian-status-panel-bash-header');
      expect(expandedHeaderAgain).not.toBeNull();
      const expandedLabelAgain = expandedHeaderAgain!.querySelector('.claudian-tool-label');
      expect(expandedLabelAgain).not.toBeNull();
      expect(expandedLabelAgain!.textContent).toBe('Command panel');
    });

    it('should collapse and expand individual bash output entries', () => {
      panel.addBashOutput({
        id: 'bash-1',
        command: 'echo hello',
        status: 'completed',
        output: 'hello',
        exitCode: 0,
      });

      const entry = containerEl.querySelector('.claudian-status-panel-bash-entry');
      expect(entry).not.toBeNull();

      const entryHeader = entry!.querySelector('.claudian-tool-header');
      const entryContent = entry!.querySelector('.claudian-tool-content');

      expect(entryContent).not.toBeNull();
      expect(entryContent!.style.display).toBe('block');
      expect(entryHeader!.getAttribute('aria-expanded')).toBe('true');

      entryHeader!.click();

      const entryAfterClick = containerEl.querySelector('.claudian-status-panel-bash-entry');
      const contentAfterClick = entryAfterClick!.querySelector('.claudian-tool-content');
      const headerAfterClick = entryAfterClick!.querySelector('.claudian-tool-header');

      expect(contentAfterClick!.style.display).toBe('none');
      expect(headerAfterClick!.getAttribute('aria-expanded')).toBe('false');

      const event = { type: 'keydown', key: 'Enter', preventDefault: jest.fn() };
      headerAfterClick!.dispatchEvent(event);

      const entryAfterKeydown = containerEl.querySelector('.claudian-status-panel-bash-entry');
      const contentAfterKeydown = entryAfterKeydown!.querySelector('.claudian-tool-content');
      const headerAfterKeydown = entryAfterKeydown!.querySelector('.claudian-tool-header');

      expect(event.preventDefault).toHaveBeenCalled();
      expect(contentAfterKeydown!.style.display).toBe('block');
      expect(headerAfterKeydown!.getAttribute('aria-expanded')).toBe('true');
    });

    it('should clear bash outputs via action button', () => {
      panel.addBashOutput({
        id: 'bash-1',
        command: 'echo hello',
        status: 'completed',
        output: 'hello',
        exitCode: 0,
      });

      const clearButton = containerEl.querySelector('.claudian-status-panel-bash-action-clear');
      expect(clearButton).not.toBeNull();

      clearButton!.click();

      const bashContainer = containerEl.querySelector('.claudian-status-panel-bash');
      expect(bashContainer).not.toBeNull();
      expect(bashContainer!.style.display).toBe('none');
    });

    it('should stopPropagation on clear button keydown to prevent header toggle', () => {
      panel.addBashOutput({
        id: 'bash-1',
        command: 'echo hello',
        status: 'completed',
        output: 'hello',
        exitCode: 0,
      });

      const content = containerEl.querySelector('.claudian-status-panel-bash-content');
      expect(content!.style.display).toBe('block');

      const clearButton = containerEl.querySelector('.claudian-status-panel-bash-action-clear');
      expect(clearButton).not.toBeNull();

      const event = { type: 'keydown', key: 'Enter', preventDefault: jest.fn(), stopPropagation: jest.fn() };
      clearButton!.dispatchEvent(event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(event.stopPropagation).toHaveBeenCalled();
    });

    it('should copy latest bash output via action button', async () => {
      panel.addBashOutput({
        id: 'bash-1',
        command: 'echo hello',
        status: 'completed',
        output: 'hello',
        exitCode: 0,
      });

      const copyButton = containerEl.querySelector('.claudian-status-panel-bash-action-copy');
      expect(copyButton).not.toBeNull();

      copyButton!.click();

      await Promise.resolve();
      expect(writeTextMock).toHaveBeenCalledWith('$ echo hello\nhello');
    });

    it('should stopPropagation on copy button keydown to prevent header toggle', async () => {
      panel.addBashOutput({
        id: 'bash-1',
        command: 'echo hello',
        status: 'completed',
        output: 'hello',
        exitCode: 0,
      });

      const content = containerEl.querySelector('.claudian-status-panel-bash-content');
      expect(content!.style.display).toBe('block');

      const copyButton = containerEl.querySelector('.claudian-status-panel-bash-action-copy');
      expect(copyButton).not.toBeNull();

      const event = { type: 'keydown', key: ' ', preventDefault: jest.fn(), stopPropagation: jest.fn() };
      copyButton!.dispatchEvent(event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(event.stopPropagation).toHaveBeenCalled();

      await Promise.resolve();
      expect(writeTextMock).toHaveBeenCalledWith('$ echo hello\nhello');
    });

    it('should cap bash outputs to the most recent entries', () => {
      for (let i = 0; i < 55; i++) {
        panel.addBashOutput({
          id: `bash-${i}`,
          command: `echo ${i}`,
          status: 'completed',
          output: `${i}`,
          exitCode: 0,
        });
      }

      const entries = containerEl.querySelectorAll('.claudian-status-panel-bash-entry');
      expect(entries.length).toBe(50);
    });

    it('should scroll bash content to bottom when outputs update', () => {
      panel.addBashOutput({
        id: 'bash-1',
        command: 'echo hello',
        status: 'completed',
        output: 'hello',
        exitCode: 0,
      });

      const content = containerEl.querySelector('.claudian-status-panel-bash-content');
      expect(content).not.toBeNull();
      expect((content as any).scrollTop).toBe((content as any).scrollHeight);
    });

    it('should update a running bash output to completed with output', () => {
      panel.addBashOutput({
        id: 'bash-1',
        command: 'echo hello',
        status: 'running',
        output: '',
      });

      let entry = containerEl.querySelector('.claudian-status-panel-bash-entry');
      let text = entry!.querySelector('.claudian-tool-result-text');
      expect(text!.textContent).toBe('Running...');

      panel.updateBashOutput('bash-1', { status: 'completed', output: 'hello', exitCode: 0 });

      entry = containerEl.querySelector('.claudian-status-panel-bash-entry');
      text = entry!.querySelector('.claudian-tool-result-text');
      expect(text!.textContent).toBe('hello');

      const statusEl = entry!.querySelector('.claudian-tool-status');
      expect(statusEl!.classList.contains('status-completed')).toBe(true);
    });

    it('should update a running bash output to error', () => {
      panel.addBashOutput({
        id: 'bash-1',
        command: 'bad-command',
        status: 'running',
        output: '',
      });

      panel.updateBashOutput('bash-1', { status: 'error', output: 'command not found', exitCode: 127 });

      const entry = containerEl.querySelector('.claudian-status-panel-bash-entry');
      const text = entry!.querySelector('.claudian-tool-result-text');
      expect(text!.textContent).toBe('command not found');

      const statusEl = entry!.querySelector('.claudian-tool-status');
      expect(statusEl!.classList.contains('status-error')).toBe(true);
    });

    it('should be a no-op when updating a non-existent bash output', () => {
      panel.addBashOutput({
        id: 'bash-1',
        command: 'echo hello',
        status: 'running',
        output: '',
      });

      panel.updateBashOutput('nonexistent', { status: 'completed', output: 'done' });

      const entry = containerEl.querySelector('.claudian-status-panel-bash-entry');
      const text = entry!.querySelector('.claudian-tool-result-text');
      expect(text!.textContent).toBe('Running...');
    });

    it('should set aria-expanded on the bash section header', () => {
      panel.addBashOutput({
        id: 'bash-1',
        command: 'echo hello',
        status: 'completed',
        output: 'hello',
        exitCode: 0,
      });

      const header = containerEl.querySelector('.claudian-status-panel-bash-header');
      expect(header!.getAttribute('aria-expanded')).toBe('true');

      header!.click();
      const headerAfterCollapse = containerEl.querySelector('.claudian-status-panel-bash-header');
      expect(headerAfterCollapse!.getAttribute('aria-expanded')).toBe('false');

      headerAfterCollapse!.click();
      const headerAfterExpand = containerEl.querySelector('.claudian-status-panel-bash-header');
      expect(headerAfterExpand!.getAttribute('aria-expanded')).toBe('true');
    });

    it('should handle clipboard failure gracefully', async () => {
      writeTextMock.mockRejectedValueOnce(new Error('Clipboard denied'));

      panel.addBashOutput({
        id: 'bash-1',
        command: 'echo hello',
        status: 'completed',
        output: 'hello',
        exitCode: 0,
      });

      const copyButton = containerEl.querySelector('.claudian-status-panel-bash-action-copy');
      expect(copyButton).not.toBeNull();

      copyButton!.click();

      await Promise.resolve();
      expect(writeTextMock).toHaveBeenCalled();
    });
  });
});
