import type { App, EventRef, WorkspaceLeaf } from 'obsidian';
import { Platform } from 'obsidian';

import { VIEW_TYPE_CLAUDIAN, type ZenModePosition } from '@/core/types';
import { scheduleAnimationFrame } from '@/features/chat/utils/animationFrame';
import type { ZenModeSource, ZenPresentationPort, ZenScrollSnapshot } from '@/features/chat/zen/types';
import { ZenModePanel } from '@/features/chat/zen/ZenModePanel';

export interface ZenModeControllerDeps {
  readonly app: App;
  /** Reads the committed setting. */
  isEnabled(): boolean;
  /** Reads where the panel was left; null keeps it docked. */
  getPosition(): ZenModePosition | null;
  /** Remembers where the user moved the panel. */
  savePosition(position: ZenModePosition | null): void;
}

interface ZenAttachment {
  readonly source: ZenModeSource;
  readonly panel: ZenModePanel;
  readonly release: () => void;
}

type CollapsibleSplit = { collapsed?: unknown };

/**
 * Locates Obsidian's central workspace split. Its element is not in the public
 * typings, so this is the single guarded host lookup; unsupported markup skips zen.
 */
function findCentralWorkspaceHost(app: App): HTMLElement | null {
  const containerEl = (app.workspace as { containerEl?: HTMLElement }).containerEl;
  return containerEl?.querySelector<HTMLElement>(':scope > .workspace-split.mod-root') ?? null;
}

/**
 * Single workspace owner for zen mode: selects at most one eligible chat view
 * whose containing sidebar is collapsed and hosts its live presentation in the
 * central workspace. It never creates or reveals views to supply itself; it only
 * loads a chat that Obsidian deferred inside a collapsed sidebar.
 */
export class ZenModeController {
  readonly #sources = new Map<ZenModeSource, () => void>();
  readonly #historyExpanded = new WeakMap<ZenModeSource, boolean>();
  readonly #loadRequested = new WeakSet<WorkspaceLeaf>();
  #focusOrder: ZenModeSource[] = [];
  #eventRefs: EventRef[] = [];
  #attachment: ZenAttachment | null = null;
  #listening = false;
  #reconciling = false;
  #reconcileAgain = false;
  #disposed = false;

  constructor(private readonly deps: ZenModeControllerDeps) {}

  start(): void {
    if (this.#listening || this.#disposed) return;
    const { workspace } = this.deps.app;
    workspace.onLayoutReady(() => {
      if (this.#listening || this.#disposed) return;
      this.#listening = true;
      this.#eventRefs.push(
        // Sidebar collapse flips synchronously; resize follows the toggle animation.
        workspace.on('resize', () => this.reconcile()),
        workspace.on('layout-change', () => this.reconcile()),
        workspace.on('active-leaf-change', (leaf) => this.#handleActiveLeafChange(leaf)),
      );
      this.reconcile();
    });
  }

  register(source: ZenModeSource): () => void {
    if (this.#disposed || this.#sources.has(source)) return () => undefined;
    this.#sources.set(source, source.onZenPresentationChanged(() => this.reconcile()));
    this.reconcile();
    return () => this.#unregister(source);
  }

  reconcile(): void {
    if (this.#disposed) return;
    // Moving nodes can publish presentation changes; finish one pass before the next.
    if (this.#reconciling) {
      this.#reconcileAgain = true;
      return;
    }
    this.#reconciling = true;
    try {
      do {
        this.#reconcileAgain = false;
        this.#reconcileOnce();
      } while (this.#reconcileAgain && !this.#disposed);
    } finally {
      this.#reconciling = false;
    }
  }

  #reconcileOnce(): void {
    const target = this.#selectSource();
    const attachment = this.#attachment;
    if (attachment && attachment.source === target) {
      // The source already placed a replaced runtime; only the bound state changes.
      attachment.panel.bind(target.getZenPresentation(), target.getZenProviderId());
      return;
    }
    this.#detach();
    if (target) this.#attach(target);
    else this.#loadDeferredSource();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#detach();
    this.#disposed = true;
    for (const ref of this.#eventRefs) this.deps.app.workspace.offref(ref);
    this.#eventRefs = [];
    for (const unsubscribe of this.#sources.values()) unsubscribe();
    this.#sources.clear();
    this.#focusOrder = [];
  }

  #unregister(source: ZenModeSource): void {
    const unsubscribe = this.#sources.get(source);
    if (!unsubscribe) return;
    this.#sources.delete(source);
    this.#focusOrder = this.#focusOrder.filter(candidate => candidate !== source);
    unsubscribe();
    if (this.#attachment?.source === source) this.#detach();
    this.reconcile();
  }

  #handleActiveLeafChange(leaf: WorkspaceLeaf | null): void {
    const source = [...this.#sources.keys()].find(candidate => candidate.leaf === leaf);
    if (source) {
      this.#focusOrder = [...this.#focusOrder.filter(candidate => candidate !== source), source];
    }
    this.reconcile();
  }

  #canPresent(): boolean {
    return this.#listening && !Platform.isMobile && this.deps.isEnabled();
  }

  #selectSource(): ZenModeSource | null {
    if (!this.#canPresent()) return null;
    const eligible = [...this.#sources.keys()].filter(source => this.#isEligible(source));
    if (eligible.length === 0) return null;

    const current = this.#attachment?.source;
    if (current && eligible.includes(current)) return current;
    for (let index = this.#focusOrder.length - 1; index >= 0; index -= 1) {
      if (eligible.includes(this.#focusOrder[index])) return this.#focusOrder[index];
    }
    const leafOrder = this.deps.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN);
    const orderOf = (source: ZenModeSource) => {
      const index = leafOrder.indexOf(source.leaf);
      return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    };
    return [...eligible].sort((a, b) => orderOf(a) - orderOf(b))[0];
  }

  #isEligible(source: ZenModeSource): boolean {
    if (!source.getZenPresentation()) return false;
    return this.#isInCollapsedSidebar(source.leaf);
  }

  #isInCollapsedSidebar(leaf: WorkspaceLeaf): boolean {
    const { leftSplit, rightSplit } = this.deps.app.workspace;
    const root = leaf.getRoot();
    // Actual placement decides; the preferred placement setting is irrelevant here.
    if (root !== leftSplit && root !== rightSplit) return false;
    return (root as CollapsibleSplit).collapsed === true;
  }

  /**
   * Obsidian defers leaves inside a collapsed sidebar at startup, so their views
   * never open to register here. Loading one lets it restore normally and present
   * once ready; a registered view in a collapsed sidebar is already on its way.
   */
  #loadDeferredSource(): void {
    if (!this.#canPresent()) return;
    const pending = [...this.#sources.keys()].some(source => this.#isInCollapsedSidebar(source.leaf));
    if (pending) return;
    const leaf = this.deps.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN).find(candidate => (
      candidate.isDeferred && !this.#loadRequested.has(candidate) && this.#isInCollapsedSidebar(candidate)
    ));
    if (!leaf) return;
    // One attempt per leaf, so a failed load cannot repeat on every layout event.
    this.#loadRequested.add(leaf);
    void leaf.loadIfDeferred().catch(() => undefined);
  }

  #attach(source: ZenModeSource): void {
    const runtime = source.getZenPresentation();
    const hostEl = findCentralWorkspaceHost(this.deps.app);
    if (!runtime || !hostEl) return;

    const panel = new ZenModePanel(hostEl, {
      keymap: this.deps.app.keymap ?? null,
      historyExpanded: this.#historyExpanded.get(source) ?? false,
      onHistoryExpandedChange: expanded => this.#historyExpanded.set(source, expanded),
      position: this.deps.getPosition(),
      onPositionChange: position => this.deps.savePosition(position),
    });
    this.#attachment = { source, panel, release: source.attachZenPresentation(panel.slots) };
    panel.bind(runtime, source.getZenProviderId());
  }

  /** Restores every moved node to the source before the zen host is removed. */
  #detach(): void {
    const attachment = this.#attachment;
    if (!attachment) return;
    this.#attachment = null;
    const runtime = attachment.panel.runtime;
    const scroll = runtime ? runtime.captureScroll() : null;
    try {
      attachment.release();
    } finally {
      attachment.panel.destroy();
    }
    if (runtime && scroll) this.#restoreScroll(runtime, scroll);
  }

  #restoreScroll(runtime: ZenPresentationPort, scroll: ZenScrollSnapshot): void {
    runtime.restoreScroll(scroll);
    // A reopening sidebar may still be hidden; reapply once it has layout.
    scheduleAnimationFrame(() => {
      if (this.#attachment?.panel.runtime === runtime) return;
      runtime.restoreScroll(scroll);
    }, runtime.window);
  }

}
