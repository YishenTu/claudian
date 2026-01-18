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

    it('should add a new subagent element', () => {
      panel.updateSubagent({ id: 'task-1', description: 'New task', status: 'pending' });

      expect(containerEl.querySelectorAll('[data-panel-subagent-id]')).toHaveLength(1);
      const label = containerEl.querySelector('.claudian-subagent-label');
      expect(label?.textContent).toBe('New task');
    });

    it('should update status of existing subagent', () => {
      panel.updateSubagent({ id: 'task-1', description: 'Task', status: 'pending' });
      panel.updateSubagent({ id: 'task-1', description: 'Task', status: 'running' });

      const wrapper = containerEl.querySelectorAll('[data-panel-subagent-id]');
      expect(wrapper).toHaveLength(1);
      expect(wrapper[0].classList.has('running')).toBe(true);
    });

    it('should display status text for running subagent', () => {
      panel.updateSubagent({ id: 'task-1', description: 'Task', status: 'running' });

      const statusText = containerEl.querySelector('.claudian-subagent-status-text');
      expect(statusText?.textContent).toBe('Running in background');
    });

    it('should display status text for pending subagent', () => {
      panel.updateSubagent({ id: 'task-1', description: 'Task', status: 'pending' });

      const statusText = containerEl.querySelector('.claudian-subagent-status-text');
      expect(statusText?.textContent).toBe('Initializing');
    });

    it('should display status text for orphaned subagent', () => {
      panel.updateSubagent({ id: 'task-1', description: 'Task', status: 'orphaned' });

      const statusText = containerEl.querySelector('.claudian-subagent-status-text');
      expect(statusText?.textContent).toBe('Orphaned');
    });

    it('should clear status text for completed subagent', () => {
      panel.updateSubagent({ id: 'task-1', description: 'Task', status: 'completed' });

      const statusText = containerEl.querySelector('.claudian-subagent-status-text');
      expect(statusText?.textContent).toBe('');
    });

    it('should truncate long descriptions', () => {
      const longDescription = 'A'.repeat(50);
      panel.updateSubagent({ id: 'task-1', description: longDescription, status: 'pending' });

      const label = containerEl.querySelector('.claudian-subagent-label');
      expect(label?.textContent).toBe('A'.repeat(40) + '...');
    });

    it('should handle updateSubagent called before mount', () => {
      const unmountedPanel = new StatusPanel();

      expect(() => {
        unmountedPanel.updateSubagent({ id: 'task-1', description: 'Task', status: 'pending' });
      }).not.toThrow();
    });
  });

  describe('restoreSubagents', () => {
    beforeEach(() => {
      panel.mount(containerEl as unknown as HTMLElement);
    });

    it('should mark running subagents as orphaned after reload', () => {
      const subagents = [
        { id: 'running-1', description: 'Running task', mode: 'async' as const, asyncStatus: 'running' as const, isExpanded: false, status: 'running' as const, toolCalls: [] },
        { id: 'completed-1', description: 'Done task', mode: 'async' as const, asyncStatus: 'completed' as const, isExpanded: false, status: 'completed' as const, toolCalls: [] },
      ];

      panel.restoreSubagents(subagents);

      const elements = containerEl.querySelectorAll('[data-panel-subagent-id]');
      expect(elements).toHaveLength(2);

      // Running should become orphaned
      const runningEl = elements.find(el => el.getAttribute('data-panel-subagent-id') === 'running-1');
      expect(runningEl?.classList.has('orphaned')).toBe(true);

      // Completed should stay completed
      const completedEl = elements.find(el => el.getAttribute('data-panel-subagent-id') === 'completed-1');
      expect(completedEl?.classList.has('completed')).toBe(true);
    });

    it('should filter to async subagents only', () => {
      const subagents = [
        { id: 'sync-1', description: 'Sync task', mode: undefined, isExpanded: false, status: 'completed' as const, toolCalls: [] },
        { id: 'async-1', description: 'Async task', mode: 'async' as const, asyncStatus: 'completed' as const, isExpanded: false, status: 'completed' as const, toolCalls: [] },
      ];

      panel.restoreSubagents(subagents);

      const elements = containerEl.querySelectorAll('[data-panel-subagent-id]');
      expect(elements).toHaveLength(1);
      expect(elements[0].getAttribute('data-panel-subagent-id')).toBe('async-1');
    });

    it('should mark pending subagents as orphaned after reload', () => {
      const subagents = [
        { id: 'pending-1', description: 'Pending task', mode: 'async' as const, asyncStatus: 'pending' as const, isExpanded: false, status: 'running' as const, toolCalls: [] },
      ];

      panel.restoreSubagents(subagents);

      const elements = containerEl.querySelectorAll('[data-panel-subagent-id]');
      expect(elements).toHaveLength(1);
      expect(elements[0].classList.has('orphaned')).toBe(true);
    });

    it('should preserve error status after reload', () => {
      const subagents = [
        { id: 'error-1', description: 'Error task', mode: 'async' as const, asyncStatus: 'error' as const, isExpanded: false, status: 'error' as const, toolCalls: [] },
      ];

      panel.restoreSubagents(subagents);

      const elements = containerEl.querySelectorAll('[data-panel-subagent-id]');
      expect(elements).toHaveLength(1);
      expect(elements[0].classList.has('error')).toBe(true);
    });

    it('should preserve existing orphaned status after reload', () => {
      const subagents = [
        { id: 'orphaned-1', description: 'Orphaned task', mode: 'async' as const, asyncStatus: 'orphaned' as const, isExpanded: false, status: 'running' as const, toolCalls: [] },
      ];

      panel.restoreSubagents(subagents);

      const elements = containerEl.querySelectorAll('[data-panel-subagent-id]');
      expect(elements).toHaveLength(1);
      expect(elements[0].classList.has('orphaned')).toBe(true);
    });

    it('should clear existing subagents before restoring', () => {
      // Add initial subagent
      panel.updateSubagent({ id: 'existing-1', description: 'Existing', status: 'running' });
      expect(containerEl.querySelectorAll('[data-panel-subagent-id]')).toHaveLength(1);

      // Restore with new subagents
      const subagents = [
        { id: 'restored-1', description: 'Restored', mode: 'async' as const, asyncStatus: 'completed' as const, isExpanded: false, status: 'completed' as const, toolCalls: [] },
      ];
      panel.restoreSubagents(subagents);

      const elements = containerEl.querySelectorAll('[data-panel-subagent-id]');
      expect(elements).toHaveLength(1);
      expect(elements[0].getAttribute('data-panel-subagent-id')).toBe('restored-1');
    });
  });

  describe('subagent visibility', () => {
    beforeEach(() => {
      panel.mount(containerEl as unknown as HTMLElement);
    });

    it('should create subagents hidden by default', () => {
      panel.updateSubagent({ id: 'task-1', description: 'Task', status: 'running' });

      expect(panel.isSubagentVisible('task-1')).toBe(false);
    });

    it('should show subagent when showSubagent is called', () => {
      panel.updateSubagent({ id: 'task-1', description: 'Task', status: 'running' });

      panel.showSubagent('task-1');

      expect(panel.isSubagentVisible('task-1')).toBe(true);
    });

    it('should hide subagent when hideSubagent is called', () => {
      panel.updateSubagent({ id: 'task-1', description: 'Task', status: 'running' });
      panel.showSubagent('task-1');

      panel.hideSubagent('task-1');

      expect(panel.isSubagentVisible('task-1')).toBe(false);
    });

    it('should return false for non-existent subagent', () => {
      expect(panel.isSubagentVisible('non-existent')).toBe(false);
    });

    it('should handle showSubagent for non-existent ID gracefully', () => {
      expect(() => panel.showSubagent('non-existent')).not.toThrow();
    });

    it('should handle hideSubagent for non-existent ID gracefully', () => {
      expect(() => panel.hideSubagent('non-existent')).not.toThrow();
    });

    it('should preserve visibility when updating subagent status', () => {
      panel.updateSubagent({ id: 'task-1', description: 'Task', status: 'running' });
      panel.showSubagent('task-1');
      expect(panel.isSubagentVisible('task-1')).toBe(true);

      // Update status - visibility should remain via isSubagentVisible
      panel.updateSubagent({ id: 'task-1', description: 'Task', status: 'completed' });

      // isSubagentVisible checks the internal state which preserves visibility
      expect(panel.isSubagentVisible('task-1')).toBe(true);
    });
  });

  describe('clearTerminalSubagents', () => {
    it('should remove completed subagents but keep running ones', () => {
      panel.mount(containerEl as unknown as HTMLElement);

      // Add a running and a completed subagent
      panel.updateSubagent({ id: 'running-1', description: 'Running task', status: 'running' });
      panel.updateSubagent({ id: 'completed-1', description: 'Completed task', status: 'completed' });
      panel.updateSubagent({ id: 'error-1', description: 'Error task', status: 'error' });

      expect(containerEl.querySelectorAll('[data-panel-subagent-id]')).toHaveLength(3);

      panel.clearTerminalSubagents();

      const remaining = containerEl.querySelectorAll('[data-panel-subagent-id]');
      expect(remaining).toHaveLength(1);
      expect(remaining[0].getAttribute('data-panel-subagent-id')).toBe('running-1');
    });

    it('should remove orphaned subagents', () => {
      panel.mount(containerEl as unknown as HTMLElement);

      panel.updateSubagent({ id: 'orphaned-1', description: 'Orphaned task', status: 'orphaned' });
      panel.updateSubagent({ id: 'pending-1', description: 'Pending task', status: 'pending' });

      expect(containerEl.querySelectorAll('[data-panel-subagent-id]')).toHaveLength(2);

      panel.clearTerminalSubagents();

      const remaining = containerEl.querySelectorAll('[data-panel-subagent-id]');
      expect(remaining).toHaveLength(1);
      expect(remaining[0].getAttribute('data-panel-subagent-id')).toBe('pending-1');
    });
  });
});
