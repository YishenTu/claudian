import type { App, EventRef, WorkspaceLeaf } from 'obsidian';
import { Platform } from 'obsidian';

import { VIEW_TYPE_CLAUDIAN } from '../../../core/types';
import { scheduleAnimationFrame } from '../../../utils/animationFrame';
import type { AssembledTabRuntime } from '../tabs/types';
import type { ZenModeSource } from './types';
import {
  captureZenScrollIntent,
  restoreZenScrollIntent,
  ZenModePanel,
  type ZenScrollSnapshot,
} from './ZenModePanel';

export interface ZenModeControllerDeps {
  readonly app: App;
  /** Reads the committed setting. */
  isEnabled(): boolean;
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
 * central workspace. It never creates, loads, or reveals views to supply itself.
 */
export class ZenModeController {
  readonly #sources = new Map<ZenModeSource, () => void>();
  readonly #historyExpanded = new WeakMap<ZenModeSource, boolean>();
  #focusOrder: ZenModeSource[] = [];
  #eventRefs: EventRef[] = [];
  #attachment: ZenAttachment | null = null;
  #revealing: ZenModeSource | null = null;
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

  /** Applies committed setting changes. */
  refresh(): void {
    this.reconcile();
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
      attachment.panel.bind(target.getZenRuntime());
      return;
    }
    this.#detach();
    if (target) this.#attach(target);
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

  #selectSource(): ZenModeSource | null {
    if (!this.#listening || Platform.isMobile || !this.deps.isEnabled()) return null;
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
    if (source === this.#revealing || !source.getZenRuntime()) return false;
    const { leftSplit, rightSplit } = this.deps.app.workspace;
    const root = source.leaf.getRoot();
    // Actual placement decides; the preferred placement setting is irrelevant here.
    if (root !== leftSplit && root !== rightSplit) return false;
    return (root as CollapsibleSplit).collapsed === true;
  }

  #attach(source: ZenModeSource): void {
    const runtime = source.getZenRuntime();
    const hostEl = findCentralWorkspaceHost(this.deps.app);
    if (!runtime || !hostEl) return;

    const scroll = captureZenScrollIntent(runtime);
    const panel = new ZenModePanel(hostEl, {
      keymap: this.deps.app.keymap ?? null,
      historyExpanded: this.#historyExpanded.get(source) ?? false,
      onHistoryExpandedChange: expanded => this.#historyExpanded.set(source, expanded),
      onOpenFullChat: () => {
        void this.#openFullChat(source).catch(() => undefined);
      },
    });
    this.#attachment = { source, panel, release: source.attachZenPresentation(panel.slots) };
    panel.bind(runtime, scroll);
  }

  /** Restores every moved node to the source before the zen host is removed. */
  #detach(): void {
    const attachment = this.#attachment;
    if (!attachment) return;
    this.#attachment = null;
    const runtime = attachment.panel.runtime;
    const scroll = attachment.panel.captureScroll();
    try {
      attachment.release();
    } finally {
      attachment.panel.destroy();
    }
    if (runtime && scroll) this.#restoreScroll(runtime, scroll);
  }

  #restoreScroll(runtime: AssembledTabRuntime, scroll: ZenScrollSnapshot): void {
    restoreZenScrollIntent(runtime, scroll);
    // A reopening sidebar may still be hidden; reapply once it has layout.
    scheduleAnimationFrame(() => {
      if (this.#attachment?.panel.runtime === runtime) return;
      restoreZenScrollIntent(runtime, scroll);
    }, runtime.dom.messagesEl.ownerDocument.defaultView);
  }

  async #openFullChat(source: ZenModeSource): Promise<void> {
    this.#revealing = source;
    this.#detach();
    try {
      await this.deps.app.workspace.revealLeaf(source.leaf);
    } finally {
      this.#revealing = null;
    }
    if (this.#disposed || !this.#sources.has(source)) return;
    source.focusActiveInput();
    this.reconcile();
  }
}
