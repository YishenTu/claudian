export interface HorizontalPanelPagerPanel<PanelId extends string> {
  readonly element: HTMLElement;
  readonly id: PanelId;
}

export interface HorizontalPanelPagerState<PanelId extends string> {
  readonly activePanel: PanelId;
  readonly enabled: boolean;
  readonly panels: readonly HorizontalPanelPagerPanel<PanelId>[];
  readonly viewportWidth: number;
}

export interface HorizontalPanelPagerOptions<PanelId extends string> {
  readonly onDragTarget: (panel: PanelId) => void;
  readonly onIndicatorChange: (panel: PanelId) => void;
  readonly onSettle: (panel: PanelId) => void;
  readonly trackEl: HTMLElement;
}

type PagerPhase = 'idle' | 'recentering' | 'settling' | 'tracking';

const HORIZONTAL_INTENT_RATIO = 0.75;
const POSITION_EPSILON = 0.5;
const TWO_PANEL_ORDER_CLASSES = [
  'claudian-sidebar-surface-page--before',
  'claudian-sidebar-surface-page--active',
  'claudian-sidebar-surface-page--after',
] as const;
const REPLICA_REFERENCE_ATTRIBUTES = [
  'aria-activedescendant',
  'aria-controls',
  'aria-describedby',
  'aria-details',
  'aria-errormessage',
  'aria-flowto',
  'aria-labelledby',
  'aria-owns',
  'for',
] as const;

type ReplicaVisualStateElement = Element & Partial<{
  checked: boolean;
  indeterminate: boolean;
  open: boolean;
  selectedIndex: number;
  value: string;
}>;

function hasHorizontalIntent(event: WheelEvent): boolean {
  return !event.ctrlKey
    && event.deltaX !== 0
    && Math.abs(event.deltaX) >= Math.abs(event.deltaY) * HORIZONTAL_INTENT_RATIO;
}

/**
 * Coordinates a cyclic panel strip while leaving gesture and momentum ownership
 * to the browser's native scroll transaction and CSS scroll snapping.
 */
export class HorizontalPanelPager<PanelId extends string> {
  private activePanel: PanelId | null = null;
  private announcedDragTargets = new Set<PanelId>();
  private destroyed = false;
  private enabled = false;
  private lastIndicator: PanelId | null = null;
  private panels: readonly HorizontalPanelPagerPanel<PanelId>[] = [];
  private phase: PagerPhase = 'idle';
  private renderedPanels: readonly HorizontalPanelPagerPanel<PanelId>[] = [];
  private renderedActiveIndex = 0;
  private twoPanelDirection: -1 | 1 = 1;
  private twoPanelOrderedElements = new Set<HTMLElement>();
  private twoPanelReplicaEl: HTMLElement | null = null;
  private viewportWidth = 1;

  constructor(private readonly options: HorizontalPanelPagerOptions<PanelId>) {
    options.trackEl.addEventListener('wheel', this.handleWheel, {
      capture: true,
      passive: true,
    });
    options.trackEl.addEventListener('scroll', this.handleScroll, { passive: true });
    options.trackEl.addEventListener('scrollend', this.handleScrollEnd);
  }

  update(state: HorizontalPanelPagerState<PanelId>): void {
    if (this.destroyed) return;

    this.panels = state.panels;
    this.activePanel = this.resolveActivePanel(state.activePanel);
    this.enabled = state.enabled && this.panels.length > 1;
    this.viewportWidth = Math.max(1, state.viewportWidth);
    this.options.trackEl.classList.toggle(
      'claudian-sidebar-surface-track--paging',
      this.enabled,
    );

    if (this.phase === 'settling') return;

    this.announcedDragTargets.clear();
    this.phase = 'idle';
    this.alignActivePanel();
    this.updateIndicator(this.activePanel);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.options.trackEl.removeEventListener('wheel', this.handleWheel, true);
    this.options.trackEl.removeEventListener('scroll', this.handleScroll);
    this.options.trackEl.removeEventListener('scrollend', this.handleScrollEnd);
    this.options.trackEl.classList.remove('claudian-sidebar-surface-track--paging');
    this.announcedDragTargets.clear();
    this.clearTwoPanelLayout(true);
    this.panels = [];
    this.renderedPanels = [];
  }

  private readonly handleWheel = (event: WheelEvent): void => {
    if (
      this.destroyed
      || !this.enabled
      || !hasHorizontalIntent(event)
      || this.activePanel === null
    ) return;

    if (this.phase === 'settling') return;
    if (this.phase === 'recentering') this.phase = 'idle';
    if (this.phase === 'idle') {
      this.phase = 'tracking';
      this.announcedDragTargets.clear();
      if (this.panels.length === 2) {
        this.prepareTwoPanelDirection(Math.sign(event.deltaX));
      }
    }

    this.announceDragTarget(Math.sign(event.deltaX));
  };

  private readonly handleScroll = (): void => {
    if (
      this.destroyed
      || !this.enabled
      || this.activePanel === null
      || this.phase === 'settling'
    ) return;

    if (this.phase === 'recentering') {
      if (Math.abs(this.getScrollOffset()) <= POSITION_EPSILON) return;
      this.phase = 'idle';
    }

    if (this.phase === 'idle') {
      this.phase = 'tracking';
      this.announcedDragTargets.clear();
      const initialOffset = this.getScrollOffset();
      if (
        this.panels.length === 2
        && Math.abs(initialOffset) > POSITION_EPSILON
      ) {
        this.prepareTwoPanelDirection(Math.sign(initialOffset));
      }
    }

    const offset = this.getScrollOffset();
    if (Math.abs(offset) > POSITION_EPSILON) {
      const direction = Math.sign(offset);
      this.announceDragTarget(direction);
      this.updateIndicator(this.getAdjacentPanel(direction)?.id ?? this.activePanel);
      return;
    }
    this.updateIndicator(this.activePanel);
  };

  private readonly handleScrollEnd = (): void => {
    if (this.destroyed) return;
    if (this.phase === 'recentering') {
      this.phase = 'idle';
      return;
    }
    if (this.phase !== 'tracking' || this.activePanel === null) return;

    const settledPanel = this.getNearestRenderedPanel()?.id ?? this.activePanel;
    const changed = settledPanel !== this.activePanel;
    this.activePanel = settledPanel;
    this.announcedDragTargets.clear();
    this.phase = 'settling';
    this.updateIndicator(settledPanel);
    try {
      if (changed) this.options.onSettle(settledPanel);
    } finally {
      this.phase = 'idle';
      this.alignActivePanel();
    }
  };

  private alignActivePanel(): void {
    if (this.activePanel === null || this.panels.length === 0) {
      this.clearTwoPanelLayout();
      this.renderedPanels = [];
      this.renderedActiveIndex = 0;
      this.options.trackEl.scrollLeft = 0;
      this.phase = 'idle';
      return;
    }

    if (!this.enabled || this.panels.length === 1) {
      this.clearTwoPanelLayout();
      this.renderedPanels = this.panels;
      this.renderedActiveIndex = Math.max(
        0,
        this.panels.findIndex(panel => panel.id === this.activePanel),
      );
    } else if (this.panels.length === 2) {
      this.refreshTwoPanelReplica();
      this.configureTwoPanelDirection(this.twoPanelDirection);
      this.recenterToRenderedActivePanel();
      return;
    } else {
      this.clearTwoPanelLayout();
      const activeIndex = this.panels.findIndex(panel => panel.id === this.activePanel);
      this.renderedPanels = Array.from(
        { length: this.panels.length },
        (_, offset) => this.panels[
          (activeIndex - 1 + offset + this.panels.length) % this.panels.length
        ],
      );
      this.renderedActiveIndex = 1;
    }

    this.appendRenderedPanels();
    this.recenterToRenderedActivePanel();
  }

  private prepareTwoPanelDirection(direction: number): void {
    if (direction === 0 || this.activePanel === null || this.panels.length !== 2) return;
    this.configureTwoPanelDirection(direction);
  }

  private configureTwoPanelDirection(direction: number): void {
    if (this.activePanel === null || this.panels.length !== 2) return;
    const active = this.panels.find(panel => panel.id === this.activePanel);
    const other = this.panels.find(panel => panel.id !== this.activePanel);
    if (!active || !other) return;

    this.twoPanelDirection = direction > 0 ? 1 : -1;
    const replica = this.getTwoPanelReplica(other.id);
    this.renderedPanels = direction > 0
      ? [replica, active, other]
      : [other, active, replica];
    this.renderedActiveIndex = 1;
    this.applyTwoPanelOrder();
  }

  private getTwoPanelReplica(panelId: PanelId): HorizontalPanelPagerPanel<PanelId> {
    if (!this.twoPanelReplicaEl) {
      this.twoPanelReplicaEl = this.options.trackEl.createDiv({
        cls: 'claudian-sidebar-surface-replica',
      });
      this.twoPanelReplicaEl.setAttribute('aria-hidden', 'true');
      this.twoPanelReplicaEl.setAttribute('inert', '');
    }
    this.twoPanelReplicaEl.classList.remove('claudian-hidden');
    this.twoPanelReplicaEl.dataset.panelReplica = panelId;
    return { element: this.twoPanelReplicaEl, id: panelId };
  }

  private refreshTwoPanelReplica(): void {
    if (this.activePanel === null || this.panels.length !== 2) return;
    const other = this.panels.find(panel => panel.id !== this.activePanel);
    if (!other) return;

    const replica = this.getTwoPanelReplica(other.id).element;
    const content = other.element.cloneNode(true) as HTMLElement;
    this.copyReplicaVisualState(other.element, content);
    content.classList.add('claudian-sidebar-surface-replica-content');
    content.classList.remove('claudian-hidden');
    this.sanitizeReplicaTree(content);
    replica.replaceChildren(content);
  }

  private copyReplicaVisualState(sourceRoot: Element, replicaRoot: Element): void {
    const pending: Array<readonly [Element, Element]> = [[sourceRoot, replicaRoot]];
    while (pending.length > 0) {
      const [source, replica] = pending.pop()!;
      replica.scrollLeft = source.scrollLeft;
      replica.scrollTop = source.scrollTop;

      const sourceState = source as ReplicaVisualStateElement;
      const replicaState = replica as ReplicaVisualStateElement;
      switch (source.tagName) {
        case 'INPUT':
          replicaState.checked = sourceState.checked;
          replicaState.indeterminate = sourceState.indeterminate;
          replicaState.value = sourceState.value;
          break;
        case 'TEXTAREA':
          replicaState.value = sourceState.value;
          break;
        case 'SELECT':
          replicaState.selectedIndex = sourceState.selectedIndex;
          break;
        case 'DETAILS':
          replicaState.open = sourceState.open;
          break;
      }

      const sourceChildren = Array.from(source.children);
      const replicaChildren = Array.from(replica.children);
      for (let index = 0; index < sourceChildren.length; index += 1) {
        const replicaChild = replicaChildren[index];
        if (replicaChild) pending.push([sourceChildren[index], replicaChild]);
      }
    }
  }

  private sanitizeReplicaTree(root: HTMLElement): void {
    const pending: Element[] = [root];
    while (pending.length > 0) {
      const element = pending.pop()!;
      element.removeAttribute('id');
      element.removeAttribute('autofocus');
      for (const attribute of REPLICA_REFERENCE_ATTRIBUTES) {
        element.removeAttribute(attribute);
      }
      for (const orderClass of TWO_PANEL_ORDER_CLASSES) {
        element.classList.remove(orderClass);
      }
      pending.push(...Array.from(element.children));
    }
  }

  private applyTwoPanelOrder(): void {
    const nextElements = new Set(this.renderedPanels.map(panel => panel.element));
    for (const element of this.twoPanelOrderedElements) {
      if (!nextElements.has(element)) {
        for (const orderClass of TWO_PANEL_ORDER_CLASSES) {
          element.classList.remove(orderClass);
        }
      }
    }
    this.renderedPanels.forEach((panel, index) => {
      const orderClass = TWO_PANEL_ORDER_CLASSES[index];
      for (const candidate of TWO_PANEL_ORDER_CLASSES) {
        panel.element.classList.toggle(candidate, candidate === orderClass);
      }
    });
    this.twoPanelOrderedElements = nextElements;
  }

  private clearTwoPanelLayout(removeReplica = false): void {
    for (const element of this.twoPanelOrderedElements) {
      for (const orderClass of TWO_PANEL_ORDER_CLASSES) {
        element.classList.remove(orderClass);
      }
    }
    this.twoPanelOrderedElements.clear();
    this.twoPanelDirection = 1;
    if (!this.twoPanelReplicaEl) return;
    this.twoPanelReplicaEl.classList.add('claudian-hidden');
    this.twoPanelReplicaEl.replaceChildren();
    if (!removeReplica) return;
    this.twoPanelReplicaEl.remove();
    this.twoPanelReplicaEl = null;
  }

  private appendRenderedPanels(): void {
    for (const panel of this.renderedPanels) {
      this.options.trackEl.appendChild(panel.element);
    }
  }

  private recenterToRenderedActivePanel(): void {
    const target = this.renderedActiveIndex * this.viewportWidth;
    const changed = Math.abs(this.options.trackEl.scrollLeft - target) > POSITION_EPSILON;
    this.options.trackEl.scrollLeft = target;
    this.phase = changed ? 'recentering' : 'idle';
  }

  private getScrollOffset(): number {
    return this.options.trackEl.scrollLeft
      - this.renderedActiveIndex * this.viewportWidth;
  }

  private getNearestRenderedPanel(): HorizontalPanelPagerPanel<PanelId> | null {
    if (this.renderedPanels.length === 0) return null;
    const rawIndex = Math.round(this.options.trackEl.scrollLeft / this.viewportWidth);
    const minIndex = Math.max(0, this.renderedActiveIndex - 1);
    const maxIndex = Math.min(
      this.renderedPanels.length - 1,
      this.renderedActiveIndex + 1,
    );
    const index = Math.max(minIndex, Math.min(maxIndex, rawIndex));
    return this.renderedPanels[index] ?? null;
  }

  private announceDragTarget(direction: number): void {
    if (direction === 0 || this.activePanel === null) return;
    const target = this.getAdjacentPanel(direction);
    if (!target || this.announcedDragTargets.has(target.id)) return;
    this.announcedDragTargets.add(target.id);
    this.options.onDragTarget(target.id);
  }

  private getAdjacentPanel(direction: number): HorizontalPanelPagerPanel<PanelId> | null {
    if (this.activePanel === null || this.panels.length < 2) return null;
    const activeIndex = this.panels.findIndex(panel => panel.id === this.activePanel);
    if (activeIndex < 0) return null;
    const targetIndex = direction > 0
      ? (activeIndex + 1) % this.panels.length
      : (activeIndex - 1 + this.panels.length) % this.panels.length;
    return this.panels[targetIndex] ?? null;
  }

  private resolveActivePanel(requested: PanelId): PanelId | null {
    return this.panels.find(panel => panel.id === requested)?.id
      ?? this.panels[0]?.id
      ?? null;
  }

  private updateIndicator(panel: PanelId | null): void {
    if (panel === null || panel === this.lastIndicator) return;
    this.lastIndicator = panel;
    this.options.onIndicatorChange(panel);
  }
}
