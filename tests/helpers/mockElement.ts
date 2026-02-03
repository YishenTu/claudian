export interface MockElement {
  tagName: string;
  children: MockElement[];
  style: Record<string, string>;
  dataset: Record<string, string>;
  scrollTop: number;
  scrollHeight: number;
  innerHTML: string;
  textContent: string;
  className: string;
  classList: {
    add: (cls: string) => void;
    remove: (cls: string) => void;
    contains: (cls: string) => boolean;
    toggle: (cls: string, force?: boolean) => boolean;
  };
  addClass: (cls: string) => MockElement;
  removeClass: (cls: string) => MockElement;
  hasClass: (cls: string) => boolean;
  getClasses: () => string[];
  createDiv: (opts?: { cls?: string; text?: string }) => MockElement;
  createSpan: (opts?: { cls?: string; text?: string }) => MockElement;
  createEl: (tag: string, opts?: { cls?: string; text?: string; attr?: Record<string, string> }) => MockElement;
  appendChild: (child: any) => any;
  insertBefore: (el: MockElement, ref: MockElement | null) => void;
  firstChild: MockElement | null;
  remove: () => void;
  empty: () => void;
  contains: (node: any) => boolean;
  scrollIntoView: () => void;
  setAttribute: (name: string, value: string) => void;
  getAttribute: (name: string) => string | undefined | null;
  addEventListener: (event: string, handler: (...args: any[]) => void) => void;
  removeEventListener: (event: string, handler: (...args: any[]) => void) => void;
  dispatchEvent: (eventOrType: string | { type: string; [key: string]: any }, extraArg?: any) => void;
  click: () => void;
  getEventListenerCount: (event: string) => number;
  querySelector: (selector: string) => MockElement | null;
  querySelectorAll: (selector: string) => MockElement[];
  getBoundingClientRect: () => { top: number; left: number; width: number; height: number; right: number; bottom: number; x: number; y: number; toJSON: () => void };
  setText: (text: string) => void;
  _classes: Set<string>;
  _classList: Set<string>;
  _attributes: Map<string, string>;
  _eventListeners: Map<string, Array<(...args: any[]) => void>>;
  _children: MockElement[];
  [key: string]: any;
}

export function createMockEl(tag = 'div'): any {
  const children: MockElement[] = [];
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  const eventListeners = new Map<string, Array<(...args: any[]) => void>>();
  const dataset: Record<string, string> = {};
  const style: Record<string, string> = {};
  let textContent = '';

  const element: MockElement = {
    tagName: tag.toUpperCase(),
    children,
    style,
    dataset,
    scrollTop: 0,
    scrollHeight: 0,
    innerHTML: '',

    get textContent() {
      return textContent;
    },
    set textContent(value: string) {
      textContent = value;
    },

    get className() {
      return Array.from(classes).join(' ');
    },
    set className(value: string) {
      classes.clear();
      if (value) {
        value.split(' ').filter(Boolean).forEach(c => classes.add(c));
      }
    },

    classList: {
      add: (cls: string) => classes.add(cls),
      remove: (cls: string) => classes.delete(cls),
      contains: (cls: string) => classes.has(cls),
      toggle: (cls: string, force?: boolean) => {
        if (force === undefined) {
          if (classes.has(cls)) { classes.delete(cls); return false; }
          classes.add(cls);
          return true;
        }
        if (force) { classes.add(cls); } else { classes.delete(cls); }
        return force;
      },
    },

    addClass(cls: string) {
      cls.split(/\s+/).filter(Boolean).forEach(c => classes.add(c));
      return element;
    },
    removeClass(cls: string) {
      cls.split(/\s+/).filter(Boolean).forEach(c => classes.delete(c));
      return element;
    },
    hasClass: (cls: string) => classes.has(cls),
    getClasses: () => Array.from(classes),

    createDiv(opts?: { cls?: string; text?: string }) {
      const child = createMockEl('div');
      if (opts?.cls) child.addClass(opts.cls);
      if (opts?.text) child.textContent = opts.text;
      children.push(child);
      return child;
    },
    createSpan(opts?: { cls?: string; text?: string }) {
      const child = createMockEl('span');
      if (opts?.cls) child.addClass(opts.cls);
      if (opts?.text) child.textContent = opts.text;
      children.push(child);
      return child;
    },
    createEl(tagName: string, opts?: { cls?: string; text?: string; attr?: Record<string, string> }) {
      const child = createMockEl(tagName);
      if (opts?.cls) child.addClass(opts.cls);
      if (opts?.text) child.textContent = opts.text;
      children.push(child);
      return child;
    },

    appendChild(child: any) { children.push(child); return child; },
    insertBefore(el: MockElement, _ref: MockElement | null) { children.unshift(el); },
    get firstChild() { return children[0] || null; },
    remove() {},
    empty() {
      children.length = 0;
      element.innerHTML = '';
      textContent = '';
    },
    contains(node: any) {
      if (node === element) return true;
      return children.some(child => (child as any).contains?.(node));
    },
    scrollIntoView() {},
    focus() {},
    blur() {},

    setAttribute(name: string, value: string) { attributes.set(name, value); },
    getAttribute(name: string) { return attributes.get(name) ?? null; },

    addEventListener(event: string, handler: (...args: any[]) => void) {
      if (!eventListeners.has(event)) eventListeners.set(event, []);
      eventListeners.get(event)!.push(handler);
    },
    removeEventListener(event: string, handler: (...args: any[]) => void) {
      const handlers = eventListeners.get(event);
      if (handlers) {
        const idx = handlers.indexOf(handler);
        if (idx !== -1) handlers.splice(idx, 1);
      }
    },
    dispatchEvent(eventOrType: string | { type: string; [key: string]: any }, extraArg?: any) {
      if (typeof eventOrType === 'string') {
        const handlers = eventListeners.get(eventOrType) || [];
        handlers.forEach(h => h(extraArg));
      } else {
        const handlers = eventListeners.get(eventOrType.type) || [];
        handlers.forEach(h => h(eventOrType));
      }
    },
    click() {
      const handlers = eventListeners.get('click') || [];
      handlers.forEach(h => h({ type: 'click', target: element, stopPropagation: () => {} }));
    },
    getEventListenerCount(event: string) {
      return eventListeners.get(event)?.length ?? 0;
    },

    querySelector(selector: string) {
      const cls = selector.replace('.', '');
      const find = (el: any): MockElement | null => {
        if (el.hasClass?.(cls)) return el;
        for (const child of el.children || []) {
          const found = find(child);
          if (found) return found;
        }
        return null;
      };
      return find(element);
    },
    querySelectorAll(selector: string) {
      const cls = selector.replace('.', '');
      const results: MockElement[] = [];
      const collect = (el: any) => {
        if (el.hasClass?.(cls)) results.push(el);
        for (const child of el.children || []) collect(child);
      };
      for (const child of children) collect(child);
      return results;
    },

    getBoundingClientRect() {
      return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} };
    },

    setText(text: string) { textContent = text; },
    setAttr(name: string, value: string) { attributes.set(name, value); },
    toggleClass(cls: string, force: boolean) {
      if (force) { classes.add(cls); } else { classes.delete(cls); }
    },
    value: '',
    closest() { return { clientHeight: 600 }; },
    getEventListeners() { return eventListeners; },

    _classes: classes,
    _classList: classes,
    _attributes: attributes,
    _eventListeners: eventListeners,
    _children: children,
  };

  return element;
}
