/**
 * A document in its own window (an iframe), like an Obsidian popout: it has its own DOM constructors, and Obsidian's
 * element helpers create children in the owning document.
 */
export function createPopoutDocument(): Document {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const popoutDocument = frame.contentDocument!;
  const popoutWindow = popoutDocument.defaultView! as unknown as typeof globalThis;
  const popoutElement = popoutWindow.HTMLElement.prototype as unknown as Record<string, unknown>;
  const createChild = function (this: HTMLElement, tag: string, info?: string | DomElementInfo): HTMLElement {
    const el = this.ownerDocument.createElement(tag);
    const options = typeof info === 'string' ? { cls: info } : info ?? {};
    if (options.cls) el.className = ([] as string[]).concat(options.cls).join(' ');
    if (options.text) el.textContent = String(options.text);
    for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, String(value));
    this.append(el);
    return el;
  };
  popoutElement.createEl = createChild;
  popoutElement.createDiv = function (this: HTMLElement, info?: DomElementInfo) { return createChild.call(this, 'div', info); };
  popoutElement.createSpan = function (this: HTMLElement, info?: DomElementInfo) { return createChild.call(this, 'span', info); };
  for (const name of ['Node', 'Element', 'HTMLElement'] as const) {
    const source = globalThis[name].prototype;
    const target = popoutWindow[name].prototype;
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(source))) {
      if (!(key in target)) Object.defineProperty(target, key, descriptor);
    }
  }
  return popoutDocument;
}
