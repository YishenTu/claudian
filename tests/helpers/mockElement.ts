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
  removeAttribute: (name: string) => void;
  addEventListener: (event: string, handler: (...args: any[]) => void) => void;
  removeEventListener: (event: string, handler: (...args: any[]) => void) => void;
  dispatchEvent: (eventOrType: string | { type: string; [key: string]: any }, extraArg?: any) => void;
  click: () => void;
  getEventListenerCount: (event: string) => number;
  querySelector: (selector: string) => MockElement | null;
  querySelectorAll: (selector: string) => MockElement[];
  getBoundingClientRect: () => { top: number; left: number; width: number; height: number; right: number; bottom: number; x: number; y: number; toJSON: () => void };
  setText: (text: string) => void;
  appendText: (text: string) => void;
  setCssProps: (props: Record<string, string>) => void;
  ownerDocument: {
    activeElement: Element | null;
    body?: any;
    addEventListener?: (event: string, handler: (...args: any[]) => void) => void;
    removeEventListener?: (event: string, handler: (...args: any[]) => void) => void;
    defaultView: {
      requestAnimationFrame: (callback: FrameRequestCallback) => number;
      cancelAnimationFrame: (handle: number) => void;
      setTimeout: (callback: () => void, timeout: number) => number;
      clearTimeout: (handle: number) => void;
      setInterval: (callback: () => void, timeout: number) => number;
      clearInterval: (handle: number) => void;
    };
    createElement: (tagName: string) => MockElement;
    createElementNS: (namespace: string, tagName: string) => MockElement;
    getSelection?: () => Selection | null;
  };
  _classes: Set<string>;
  _classList: Set<string>;
  _attributes: Map<string, string>;
  _eventListeners: Map<string, Array<(...args: any[]) => void>>;
  _children: MockElement[];
  [key: string]: any;
}

const CLASS_DISPLAY: Record<string, string> = {
  'claudian-browser-selection-indicator': 'block',
  'claudian-canvas-indicator': 'block',
  'claudian-context-meter': 'flex',
  'claudian-file-indicator': 'none',
  'claudian-image-preview': 'none',
  'claudian-mcp-selector': 'flex',
  'claudian-mode-selector': 'flex',
  'claudian-permission-toggle': 'flex',
  'claudian-selection-indicator': 'block',
  'claudian-service-tier-toggle': 'flex',
  'claudian-status-panel-bash': 'block',
  'claudian-status-panel-bash-content': 'block',
  'claudian-status-panel-bash-entry-content': 'block',
  'claudian-status-panel-content': 'block',
  'claudian-status-panel-todos': 'block',
  'claudian-tab-content': 'flex',
  'claudian-thinking-budget': 'flex',
  'claudian-thinking-effort': 'flex',
};

const DISPLAY_CLASSES = new Set([
  'claudian-hidden',
  'claudian-visible-block',
  'claudian-visible-contents',
  'claudian-visible-flex',
  ...Object.keys(CLASS_DISPLAY),
]);

export function createMockEl(tag = 'div'): any {
  const children: MockElement[] = [];
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  const eventListeners = new Map<string, Array<(...args: any[]) => void>>();
  const dataset: Record<string, string> = {};
  const style: Record<string, string> = {};
  let textContent = '';

  const resolveDisplay = (): string | null => {
    if (classes.has('claudian-hidden')) return 'none';
    if (classes.has('claudian-visible-flex')) return 'flex';
    if (classes.has('claudian-visible-block')) return 'block';
    if (classes.has('claudian-visible-contents')) return 'contents';

    for (const [cls, display] of Object.entries(CLASS_DISPLAY)) {
      if (classes.has(cls)) return display;
    }

    return null;
  };

  const syncDisplay = () => {
    const display = resolveDisplay();
    if (display === null) {
      style.display = '';
      return;
    }
    style.display = display;
  };

  const updateClass = (cls: string, enabled: boolean) => {
    if (enabled) {
      classes.add(cls);
    } else {
      classes.delete(cls);
    }
    if (DISPLAY_CLASSES.has(cls)) {
      syncDisplay();
    }
  };

  const defaultView = {
    requestAnimationFrame: (callback: FrameRequestCallback): number => {
      const requestFrame =
        (globalThis as { window?: Window }).window?.requestAnimationFrame
        ?? (globalThis as { requestAnimationFrame?: typeof requestAnimationFrame }).requestAnimationFrame;
      if (typeof requestFrame === 'function') {
        return requestFrame(callback);
      }
      return globalThis.setTimeout(() => callback(performance.now()), 16) as unknown as number;
    },
    cancelAnimationFrame: (handle: number): void => {
      const cancelFrame =
        (globalThis as { window?: Window }).window?.cancelAnimationFrame
        ?? (globalThis as { cancelAnimationFrame?: typeof cancelAnimationFrame }).cancelAnimationFrame;
      if (typeof cancelFrame === 'function') {
        cancelFrame(handle);
        return;
      }
      globalThis.clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    },
    setTimeout: (callback: () => void, timeout: number): number =>
      globalThis.setTimeout(callback, timeout) as unknown as number,
    clearTimeout: (handle: number): void => {
      globalThis.clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    },
    setInterval: (callback: () => void, timeout: number): number =>
      globalThis.setInterval(callback, timeout) as unknown as number,
    clearInterval: (handle: number): void => {
      globalThis.clearInterval(handle as unknown as ReturnType<typeof setInterval>);
    },
  };

  const ownerDocument = {
    get activeElement() {
      return (globalThis as any).document?.activeElement ?? null;
    },
    addEventListener: (event: string, handler: (...args: any[]) => void) => {
      (globalThis as any).document?.addEventListener?.(event, handler);
    },
    removeEventListener: (event: string, handler: (...args: any[]) => void) => {
      (globalThis as any).document?.removeEventListener?.(event, handler);
    },
    getSelection: () => (globalThis as any).document?.getSelection?.() ?? null,
    defaultView,
    createElement: (tagName: string) => createMockEl(tagName),
    createElementNS: (_namespace: string, tagName: string) => createMockEl(tagName),
    body: {
      createDiv: (opts?: { cls?: string; text?: string }) => {
        const child = createMockEl('div');
        if (opts?.cls) child.addClass(opts.cls);
        if (opts?.text) child.textContent = opts.text;
        return child;
      },
    },
  };

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
      syncDisplay();
    },

    classList: {
      add: (cls: string) => updateClass(cls, true),
      remove: (cls: string) => updateClass(cls, false),
      contains: (cls: string) => classes.has(cls),
      toggle: (cls: string, force?: boolean) => {
        if (force === undefined) {
          if (classes.has(cls)) {
            updateClass(cls, false);
            return false;
          }
          updateClass(cls, true);
          return true;
        }
        updateClass(cls, force);
        return force;
      },
    },

    addClass(cls: string) {
      cls.split(/\s+/).filter(Boolean).forEach(c => updateClass(c, true));
      return element;
    },
    removeClass(cls: string) {
      cls.split(/\s+/).filter(Boolean).forEach(c => updateClass(c, false));
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
      if (opts?.attr) {
        for (const [name, value] of Object.entries(opts.attr)) {
          child.setAttribute(name, value);
        }
      }
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

    setAttribute(name: string, value: string) {
      if (name === 'class') {
        element.className = value;
      } else {
        attributes.set(name, value);
      }
      if (name.startsWith('data-')) {
        dataset[name.slice(5).replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())] = value;
      }
    },
    getAttribute(name: string) {
      if (name === 'class') return element.className;
      return attributes.get(name) ?? null;
    },
    removeAttribute(name: string) {
      if (name === 'class') {
        element.className = '';
      } else {
        attributes.delete(name);
      }
      if (name.startsWith('data-')) {
        delete dataset[name.slice(5).replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())];
      }
    },

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
    appendText(text: string) { textContent += text; },
    setCssProps(props: Record<string, string>) {
      for (const [name, value] of Object.entries(props)) {
        style[name] = value;
      }
    },
    setAttr(name: string, value: string) { element.setAttribute(name, value); },
    toggleClass(cls: string, force: boolean) {
      updateClass(cls, force);
    },
    value: '',
    closest() { return { clientHeight: 600 }; },
    getEventListeners() { return eventListeners; },
    ownerDocument,

    _classes: classes,
    _classList: classes,
    _attributes: attributes,
    _eventListeners: eventListeners,
    _children: children,
  };

  return element;
}
