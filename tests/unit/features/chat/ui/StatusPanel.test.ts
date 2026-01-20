/**
 * Tests for StatusPanel component
 */

import type { TodoItem } from '@/core/tools';
import { StatusPanel } from '@/features/chat/ui/StatusPanel';

// Mock obsidian setIcon
jest.mock('obsidian', () => ({
  setIcon: jest.fn((el: any, iconName: string) => {
    el.setAttribute('data-icon', iconName);
  }),
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
    return 0;
  }

  set scrollTop(_value: number) {
    // no-op for mock
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
    this.dispatchEvent({ type: 'click' });
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

  beforeEach(() => {
    originalDocument = (global as any).document;
    (global as any).document = createMockDocument();
    containerEl = new MockElement('div');
    panel = new StatusPanel();
  });

  afterEach(() => {
    panel.destroy();
    (global as any).document = originalDocument;
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
});
