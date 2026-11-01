/**
 * Obsidian's `onNodeInserted` listens for the `node-inserted` CSS animation that `.node-insert-event` elements start
 * whenever they become rendered: inserted into a document (including another window's) or shown again. jsdom runs no
 * animations or layout, so tests start them with `startNodeInsertAnimations` after the step that renders the element.
 */
const INSERT_EVENT_CLASS = 'node-insert-event';
const ANIMATION_NAME = 'node-inserted';
const listenerCounts = new WeakMap<HTMLElement, number>();

/** Stands in for the host's `isShown()` (`offsetParent !== null`), which jsdom's missing layout always fails. */
function isRendered(element: Element): boolean {
  if (!element.isConnected) return false;
  const view = element.ownerDocument.defaultView!;
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (view.getComputedStyle(current).display === 'none') return false;
  }
  return true;
}

/** Starts the insertion animation on the rendered `.node-insert-event` elements in `root`, as the browser would. */
export function startNodeInsertAnimations(root: Element): void {
  const EventConstructor = root.ownerDocument.defaultView!.Event;
  const targets = [...(root.matches(`.${INSERT_EVENT_CLASS}`) ? [root] : []), ...root.querySelectorAll(`.${INSERT_EVENT_CLASS}`)];
  for (const target of targets) {
    if (!isRendered(target)) continue;
    const event = new EventConstructor('animationstart', { bubbles: true });
    Object.defineProperty(event, 'animationName', { value: ANIMATION_NAME });
    target.dispatchEvent(event);
  }
}

export function installNodeInsertionEvents(prototype: HTMLElement): void {
  prototype.onNodeInserted = function (this: HTMLElement, listener: () => unknown, once?: boolean): () => void {
    const handler = (event: Event) => {
      if (!isRendered(this) || (event as AnimationEvent).animationName !== ANIMATION_NAME || event.target !== this) return;
      if (once) remove();
      listener();
    };
    const remove = () => {
      this.removeEventListener('animationstart', handler);
      const count = (listenerCounts.get(this) ?? 0) - 1;
      if (count <= 0) {
        listenerCounts.delete(this);
        this.classList.remove(INSERT_EVENT_CLASS);
      } else listenerCounts.set(this, count);
    };
    listenerCounts.set(this, (listenerCounts.get(this) ?? 0) + 1);
    this.classList.add(INSERT_EVENT_CLASS);
    this.addEventListener('animationstart', handler);
    return remove;
  };
  prototype.onWindowMigrated = function (this: HTMLElement, listener: (win: Window) => unknown): () => void {
    let win = this.win;
    return this.onNodeInserted(() => {
      if (this.win === win) return;
      win = this.win;
      listener(win);
    });
  };
}
