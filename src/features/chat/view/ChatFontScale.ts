import type { EventRef, Workspace } from 'obsidian';

const SCALE_PROPERTY = '--claudian-font-scale';

export interface ChatFontScaleDeps {
  /** Its container lives in the main window; popouts are found through their leaves and `window-open`. */
  workspace: Pick<Workspace, 'containerEl' | 'iterateAllLeaves' | 'on' | 'offref'>;
  getPercent(): number;
}

/**
 * Owns the chat font scale on every window body. Chat surfaces, including those mounted on
 * `document.body`, size text from `--claudian-font-px`, which multiplies in this property.
 */
export class ChatFontScale {
  readonly #bodies = new Set<HTMLElement>();
  #eventRefs: EventRef[] = [];

  constructor(private readonly deps: ChatFontScaleDeps) {}

  start(): void {
    const { workspace } = this.deps;
    this.#attach(workspace.containerEl.ownerDocument.body);
    // Popouts already open when the plugin loads; every popout holds at least one leaf.
    workspace.iterateAllLeaves(leaf => this.#attach(leaf.view.containerEl.ownerDocument.body));
    this.#eventRefs = [
      workspace.on('window-open', (_window, win) => this.#attach(win.document.body)),
      workspace.on('window-close', (_window, win) => { this.#bodies.delete(win.document.body); }),
    ];
  }

  /** Applies the committed scale after a settings change. */
  reconcile(): void {
    for (const body of this.#bodies) this.#apply(body);
  }

  dispose(): void {
    for (const ref of this.#eventRefs) this.deps.workspace.offref(ref);
    this.#eventRefs = [];
    for (const body of this.#bodies) body.style.removeProperty(SCALE_PROPERTY);
    this.#bodies.clear();
  }

  #attach(body: HTMLElement): void {
    this.#bodies.add(body);
    this.#apply(body);
  }

  #apply(body: HTMLElement): void {
    body.style.setProperty(SCALE_PROPERTY, String(this.deps.getPercent() / 100));
  }
}
