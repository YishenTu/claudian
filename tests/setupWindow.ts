type TestWindow = typeof globalThis & {
  cancelAnimationFrame?: (handle: number) => void;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
};

const testWindow = globalThis as TestWindow;

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

if (!('window' in globalThis)) {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: testWindow,
    writable: true,
  });
}

// Polyfill Obsidian DOM helpers for jsdom-based tests.
const SVG_NS = 'http://www.w3.org/2000/svg';

function applyDomElementInfo(el: Element, info: unknown): void {
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
  if (opts.title && 'setAttribute' in el) {
    el.setAttribute('title', String(opts.title));
  }
}

(globalThis as typeof globalThis & { createDiv?: typeof createDiv }).createDiv = function createDiv(
  info?: unknown,
  callback?: (el: HTMLDivElement) => void,
): HTMLDivElement {
  const el = document.createElement('div');
  applyDomElementInfo(el, info);
  if (callback) callback(el);
  return el;
};

(globalThis as typeof globalThis & { createEl?: typeof createEl }).createEl = function createEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  info?: unknown,
  callback?: (el: HTMLElementTagNameMap[K]) => void,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyDomElementInfo(el, info);
  if (callback) callback(el);
  return el;
};

(globalThis as typeof globalThis & { createSpan?: typeof createSpan }).createSpan = function createSpan(
  info?: unknown,
  callback?: (el: HTMLSpanElement) => void,
): HTMLSpanElement {
  const el = document.createElement('span');
  applyDomElementInfo(el, info);
  if (callback) callback(el);
  return el;
};

(globalThis as typeof globalThis & { createSvg?: typeof createSvg }).createSvg = function createSvg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  info?: unknown,
  callback?: (el: SVGElementTagNameMap[K]) => void,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
  applyDomElementInfo(el, info);
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

if (globalThis.HTMLElement && !('createDiv' in globalThis.HTMLElement.prototype)) {
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

if (globalThis.SVGElement && !('createSvg' in globalThis.SVGElement.prototype)) {
  globalThis.SVGElement.prototype.createSvg = function (this: SVGElement, tag, info?, callback?) {
    const el = createSvg(tag, info, callback);
    this.appendChild(el);
    return el;
  };
}
