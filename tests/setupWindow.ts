import { TextDecoder, TextEncoder } from 'node:util';
import { deserialize, serialize } from 'node:v8';

import type * as AxeAdapter from '@test/helpers/accessibility';
import { ControlledResizeObserver, resetResizeObservers } from '@test/helpers/dom/ResizeObserver';
import { resetObsidianKeymaps } from '@test/helpers/ObsidianKeymap';
import { resetWorkspaceTimers } from '@test/helpers/ObsidianWorkspace';


// Node-only suites do not need to load the accessibility engine.
if (typeof document !== 'undefined') {
  const { toHaveNoViolations } = await vi.importActual<typeof AxeAdapter>('@test/helpers/accessibility');
  expect.extend(toHaveNoViolations);
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = ControlledResizeObserver;
  }
  afterEach(resetResizeObservers);
}

type TestWindow = typeof globalThis & {
  cancelAnimationFrame?: (handle: number) => void;
  localStorage?: Storage;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
};

const testWindow = globalThis as TestWindow;
afterEach(resetWorkspaceTimers);
afterEach(resetObsidianKeymaps);

if (!globalThis.TextEncoder) {
  Object.assign(globalThis, { TextDecoder, TextEncoder });
}

// jsdom omits Node's structuredClone; V8 serialization implements the same algorithm.
if (typeof globalThis.structuredClone !== 'function') {
  Object.assign(globalThis, {
    structuredClone: <T>(value: T): T => deserialize(serialize(value)) as T,
  });
}

if (!testWindow.requestAnimationFrame) {
  testWindow.requestAnimationFrame = (callback: FrameRequestCallback): number => (
    Number(setTimeout(() => callback(Date.now()), 0))
  );
}

if (!testWindow.cancelAnimationFrame) {
  testWindow.cancelAnimationFrame = (handle: number): void => {
    clearTimeout(handle);
  };
}

if (globalThis.Range && !Reflect.has(globalThis.Range.prototype, 'getClientRects')) {
  Object.defineProperty(globalThis.Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => [],
  });
}

// jsdom has no layout/scrolling engine. Callers can spy on this native boundary;
// a successful call does not establish any rendered geometry or scroll position.
if (globalThis.HTMLElement && !Reflect.has(globalThis.HTMLElement.prototype, 'scrollIntoView')) {
  globalThis.HTMLElement.prototype.scrollIntoView = function () {};
}

if (!('window' in globalThis)) {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: testWindow,
    writable: true,
  });
}

// Node's native localStorage is shared across VM workers; use per-file storage instead.
if (typeof document === 'undefined' || !testWindow.localStorage) {
  const values = new Map<string, string>();
  Object.defineProperty(testWindow, 'localStorage', {
    configurable: true,
    value: {
      get length() {
        return values.size;
      },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    } satisfies Storage,
  });
}

// Keep the real identity hashing/cache; tests may replace storage before importing it.
testWindow.localStorage!.setItem('claudian.deviceSettingsKey', 'claudian-test-installation');

// Polyfill Obsidian DOM helpers for jsdom-based tests.
const SVG_NS = 'http://www.w3.org/2000/svg';

function applyDOMElementInfo(el: Element, info: unknown): void {
  if (!info) return;
  if (typeof info === 'string') {
    el.classList.add(...info.split(/\s+/).filter(Boolean));
    return;
  }
  const opts = info as Record<string, unknown>;
  if (opts.cls) {
    const classes = Array.isArray(opts.cls) ? opts.cls : String(opts.cls).split(/\s+/);
    el.classList.add(...classes.filter(Boolean) as string[]);
  }
  if (opts.text && 'textContent' in el) {
    (el as HTMLElement).textContent = String(opts.text);
  }
  if (opts.attr) {
    for (const [key, value] of Object.entries(opts.attr as Record<string, unknown>)) {
      if (value === null || value === undefined) continue;
      el.setAttribute(key, String(value));
    }
  }
  if (opts.type !== undefined) el.setAttribute('type', String(opts.type));
  if (opts.value !== undefined && 'value' in el) (el as HTMLInputElement).value = String(opts.value);
  if (opts.title && 'setAttribute' in el) {
    el.setAttribute('title', String(opts.title));
  }
}

(globalThis as typeof globalThis & { createDiv?: typeof createDiv }).createDiv = function createDiv(
  info?: unknown,
  callback?: (el: HTMLDivElement) => void,
): HTMLDivElement {
  const el = document.createElement('div');
  applyDOMElementInfo(el, info);
  if (callback) callback(el);
  return el;
};

(globalThis as typeof globalThis & { createEl?: typeof createEl }).createEl = function createEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  info?: unknown,
  callback?: (el: HTMLElementTagNameMap[K]) => void,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyDOMElementInfo(el, info);
  if (callback) callback(el);
  return el;
};

(globalThis as typeof globalThis & { createSpan?: typeof createSpan }).createSpan = function createSpan(
  info?: unknown,
  callback?: (el: HTMLSpanElement) => void,
): HTMLSpanElement {
  const el = document.createElement('span');
  applyDOMElementInfo(el, info);
  if (callback) callback(el);
  return el;
};

(globalThis as typeof globalThis & { createSvg?: typeof createSvg }).createSvg = function createSvg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  info?: unknown,
  callback?: (el: SVGElementTagNameMap[K]) => void,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
  applyDOMElementInfo(el, info);
  if (callback) callback(el);
  return el;
};

(globalThis as typeof globalThis & { createFragment?: typeof createFragment }).createFragment = function createFragment(
  callback?: (el: DocumentFragment) => void,
): DocumentFragment {
  const el = document.createDocumentFragment();
  if (callback) callback(el);
  return el;
};

if (globalThis.Node && !Reflect.has(globalThis.Node.prototype, 'win')) {
  Object.defineProperty(globalThis.Node.prototype, 'win', {
    configurable: true,
    get(this: Node): Window {
      const owner = this.nodeType === Node.DOCUMENT_NODE
        ? this as Document
        : this.ownerDocument;
      return owner?.defaultView ?? globalThis.window;
    },
  });
}

if (globalThis.HTMLElement && !Reflect.has(globalThis.HTMLElement.prototype, 'createDiv')) {
  globalThis.HTMLElement.prototype.createDiv = function (this: HTMLElement, info?, callback?) {
    const el = createDiv(info, callback);
    this.appendChild(el);
    return el;
  };
  globalThis.HTMLElement.prototype.createEl = function (this: HTMLElement, tag, info?, callback?) {
    const el = createEl(tag, info, callback);
    this.appendChild(el);
    return el;
  };
  globalThis.HTMLElement.prototype.createSpan = function (this: HTMLElement, info?, callback?) {
    const el = createSpan(info, callback);
    this.appendChild(el);
    return el;
  };
  globalThis.HTMLElement.prototype.createSvg = function (this: HTMLElement, tag, info?, callback?) {
    const el = createSvg(tag, info, callback);
    this.appendChild(el);
    return el;
  };
}

if (globalThis.HTMLElement && !Reflect.has(globalThis.HTMLElement.prototype, 'setText')) {
  globalThis.HTMLElement.prototype.setText = function (this: HTMLElement, value: string) {
    this.textContent = value;
  };
}

if (globalThis.HTMLElement && !Reflect.has(globalThis.HTMLElement.prototype, 'setCssProps')) {
  globalThis.HTMLElement.prototype.setCssProps = function (props) {
    for (const [name, value] of Object.entries(props)) this.style.setProperty(name, value);
  };
}

if (globalThis.SVGElement && !Reflect.has(globalThis.SVGElement.prototype, 'createSvg')) {
  globalThis.SVGElement.prototype.createSvg = function (this: SVGElement, tag, info?, callback?) {
    const el = createSvg(tag, info, callback);
    this.appendChild(el);
    return el;
  };
}

// Install host DOM methods without importing settings controls or a second DOM model.
if (typeof document !== 'undefined' && globalThis.HTMLElement) {
  const prototype = globalThis.HTMLElement.prototype;
  prototype.empty = function () { this.replaceChildren(); };
  prototype.addClass = function (...classes) { this.classList.add(...classes); };
  prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
  prototype.hasClass = function (name) { return this.classList.contains(name); };
  prototype.toggleClass = function (classes, value) {
    for (const name of [classes].flat()) this.classList.toggle(name, value);
  };
  prototype.appendText = function (value) { this.append(value); };
}
