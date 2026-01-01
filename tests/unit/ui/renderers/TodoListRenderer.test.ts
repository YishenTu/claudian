/**
 * Tests for TodoListRenderer - TodoWrite tool UI
 */

import { setIcon } from 'obsidian';

import {
  parseTodoInput,
  renderStoredTodoList,
  renderTodoList,
  type TodoItem,
} from '@/ui/renderers/TodoListRenderer';

// Mock obsidian
jest.mock('obsidian', () => ({
  setIcon: jest.fn(),
}));

// Create mock HTML element with Obsidian-like methods
function createMockElement(tag = 'div'): any {
  const children: any[] = [];
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  const eventListeners = new Map<string, ((...args: unknown[]) => void)[]>();

  const element: any = {
    tagName: tag.toUpperCase(),
    children,
    style: {},
    textContent: '',
    innerHTML: '',
    get className() {
      return Array.from(classes).join(' ');
    },
    set className(value: string) {
      classes.clear();
      if (value) {
        value.split(' ').filter(Boolean).forEach(c => classes.add(c));
      }
    },
    addClass: (cls: string) => {
      classes.add(cls);
      return element;
    },
    removeClass: (cls: string) => {
      classes.delete(cls);
      return element;
    },
    hasClass: (cls: string) => classes.has(cls),
    empty: () => {
      children.length = 0;
      element.innerHTML = '';
      element.textContent = '';
    },
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    getAttribute: (name: string) => attributes.get(name),
    addEventListener: (event: string, handler: (...args: unknown[]) => void) => {
      if (!eventListeners.has(event)) eventListeners.set(event, []);
      eventListeners.get(event)!.push(handler);
    },
    createDiv: (opts?: { cls?: string; text?: string }) => {
      const child = createMockElement('div');
      if (opts?.cls) {
        opts.cls.split(' ').forEach(c => child.addClass(c));
      }
      if (opts?.text) child.textContent = opts.text;
      children.push(child);
      return child;
    },
    createSpan: (opts?: { cls?: string; text?: string }) => {
      const child = createMockElement('span');
      if (opts?.cls) {
        opts.cls.split(' ').forEach(c => child.addClass(c));
      }
      if (opts?.text) child.textContent = opts.text;
      children.push(child);
      return child;
    },
    setText: (text: string) => {
      element.textContent = text;
    },
    // Test helpers
    _classes: classes,
    _attributes: attributes,
    _eventListeners: eventListeners,
    _children: children,
  };

  return element;
}

// Helper to create sample todos
function createSampleTodos(): TodoItem[] {
  return [
    { content: 'Task 1', status: 'completed', activeForm: 'Completing Task 1' },
    { content: 'Task 2', status: 'in_progress', activeForm: 'Working on Task 2' },
    { content: 'Task 3', status: 'pending', activeForm: 'Starting Task 3' },
  ];
}

describe('TodoListRenderer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('parseTodoInput', () => {
    it('should parse valid todo input', () => {
      const input = {
        todos: [
          { content: 'Task 1', status: 'pending', activeForm: 'Doing Task 1' },
          { content: 'Task 2', status: 'completed', activeForm: 'Doing Task 2' },
        ],
      };

      const result = parseTodoInput(input);

      expect(result).toHaveLength(2);
      expect(result![0].content).toBe('Task 1');
      expect(result![1].status).toBe('completed');
    });

    it('should return null for invalid input', () => {
      expect(parseTodoInput({})).toBeNull();
      expect(parseTodoInput({ todos: 'not an array' })).toBeNull();
    });

    it('should filter out invalid todo items', () => {
      const input = {
        todos: [
          { content: 'Valid', status: 'pending', activeForm: 'Doing' },
          { content: 'Invalid status', status: 'unknown' },
          { status: 'pending' }, // missing content
        ],
      };

      const result = parseTodoInput(input);

      expect(result).toHaveLength(1);
      expect(result![0].content).toBe('Valid');
    });
  });

  describe('renderTodoList', () => {
    it('should start collapsed by default', () => {
      const parentEl = createMockElement();
      const todos = createSampleTodos();

      const container = renderTodoList(parentEl, todos);

      expect(container.hasClass('expanded')).toBe(false);
    });

    it('should set aria-expanded to false by default', () => {
      const parentEl = createMockElement();
      const todos = createSampleTodos();

      const container = renderTodoList(parentEl, todos);

      const header = (container as any)._children[0];
      expect(header.getAttribute('aria-expanded')).toBe('false');
    });

    it('should hide content by default', () => {
      const parentEl = createMockElement();
      const todos = createSampleTodos();

      const container = renderTodoList(parentEl, todos);

      const content = (container as any)._children[1];
      expect(content.style.display).toBe('none');
    });

    it('should set correct ARIA attributes for accessibility', () => {
      const parentEl = createMockElement();
      const todos = createSampleTodos();

      const container = renderTodoList(parentEl, todos);

      const header = (container as any)._children[0];
      expect(header.getAttribute('role')).toBe('button');
      expect(header.getAttribute('tabindex')).toBe('0');
      expect(header.getAttribute('aria-expanded')).toBe('false');
    });

    it('should toggle expand/collapse on header click', () => {
      const parentEl = createMockElement();
      const todos = createSampleTodos();

      const container = renderTodoList(parentEl, todos);
      const header = (container as any)._children[0];
      const content = (container as any)._children[1];

      // Initially collapsed
      expect(container.hasClass('expanded')).toBe(false);
      expect(content.style.display).toBe('none');

      // Trigger click
      const clickHandlers = header._eventListeners.get('click') || [];
      expect(clickHandlers.length).toBeGreaterThan(0);
      clickHandlers[0]();

      // Should be expanded
      expect(container.hasClass('expanded')).toBe(true);
      expect(content.style.display).toBe('block');

      // Click again to collapse
      clickHandlers[0]();
      expect(container.hasClass('expanded')).toBe(false);
      expect(content.style.display).toBe('none');
    });

    it('should update aria-expanded on toggle', () => {
      const parentEl = createMockElement();
      const todos = createSampleTodos();

      const container = renderTodoList(parentEl, todos);
      const header = (container as any)._children[0];

      // Initially collapsed
      expect(header.getAttribute('aria-expanded')).toBe('false');

      // Expand
      const clickHandlers = header._eventListeners.get('click') || [];
      clickHandlers[0]();
      expect(header.getAttribute('aria-expanded')).toBe('true');

      // Collapse
      clickHandlers[0]();
      expect(header.getAttribute('aria-expanded')).toBe('false');
    });

    it('should allow expanded state to be passed as parameter', () => {
      const parentEl = createMockElement();
      const todos = createSampleTodos();

      const container = renderTodoList(parentEl, todos, true);

      expect(container.hasClass('expanded')).toBe(true);
    });

    it('should show task count in label', () => {
      const parentEl = createMockElement();
      const todos = createSampleTodos();

      const container = renderTodoList(parentEl, todos);

      const header = (container as any)._children[0];
      const label = header._children.find((c: any) => c.hasClass('claudian-todo-label'));
      expect(label.textContent).toContain('1/3'); // 1 completed out of 3
    });

    it('should render all todo items', () => {
      const parentEl = createMockElement();
      const todos = createSampleTodos();

      const container = renderTodoList(parentEl, todos);

      const content = (container as any)._children[1];
      expect(content._children.length).toBe(3);
    });
  });

  describe('renderStoredTodoList', () => {
    it('should start collapsed by default', () => {
      const parentEl = createMockElement();
      const input = { todos: createSampleTodos() };

      const container = renderStoredTodoList(parentEl, input);

      expect(container).not.toBeNull();
      expect(container!.hasClass('expanded')).toBe(false);
    });

    it('should return null for invalid input', () => {
      const parentEl = createMockElement();

      const result = renderStoredTodoList(parentEl, {});

      expect(result).toBeNull();
    });
  });
});
