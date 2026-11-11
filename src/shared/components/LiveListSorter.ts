/** Pointer travel before a press on a row becomes a drag, so clicks still reach the row. */
const DRAG_THRESHOLD_PX = 4;
const SORTING_CLASS = 'claudian-live-sorting';
const ITEM_CLASS = 'claudian-live-sort-item';
const LIFTED_CLASS = 'claudian-live-sort-lifted';
const FOLDED_CLASS = 'claudian-live-sort-folded';
const SPACER_CLASS = 'claudian-live-sort-spacer';
/** How much of a neighbour the dragged card's leading edge covers before the neighbour moves away. */
const DISPLACE_FRACTION = 0.3;

/** The direction a list lays out and sorts along. */
export type SortAxis = 'x' | 'y';

/** Where a dropped item lands relative to the item it is dropped on. */
export type SortPlacement = 'before' | 'after';

/** A sortable item; items sort only among those of the same group in the same list. */
export interface LiveSortRow {
  readonly id: string;
  readonly group?: string;
}

export interface LiveListSorterDeps {
  /**
   * Saves the dragged item next to the target, reporting its own failure; the sorter holds the dropped layout until
   * it settles.
   */
  onDrop(id: string, targetId: string, placement: SortPlacement): Promise<void>;
  /** A drag began; hover-only presentation should close. */
  onDragStart?(): void;
  /** Row controls that keep their own pointer behavior. */
  ignoreSelector?: string;
  /** Layout direction of the list; vertical by default. */
  axis?: SortAxis;
  /** False while presses on rows should not start a drag. */
  canStart?(): boolean;
}

/** An item's row and the elements under it that fold away while it is dragged. */
interface SortEntry {
  readonly row: LiveSortRow;
  readonly block: readonly [HTMLElement, ...HTMLElement[]];
}

/** An item's extent along the sort axis. */
interface SortItem {
  readonly entry: SortEntry;
  readonly start: number;
  readonly size: number;
}

interface SortLift {
  readonly list: HTMLElement;
  /**
   * The list's viewport start and scroll position at lift, so scrolling it or any ancestor keeps the row under the
   * pointer.
   */
  readonly listStart: number;
  readonly startScroll: number;
  /** Holds the folded members' height at the end of the list's content while they are folded. */
  readonly spacer: HTMLElement | null;
  readonly dragged: SortItem;
  /** The other items of the dragged one's group, in list order. */
  readonly others: readonly SortItem[];
  readonly draggedIndex: number;
  /** Space between consecutive items, which a displaced item moves across along with the dragged height. */
  readonly gap: number;
  readonly minOffset: number;
  readonly maxOffset: number;
  targetIndex: number;
}

interface SortGesture {
  readonly entry: SortEntry;
  readonly doc: Document;
  /** Pointer position along the sort axis at the press. */
  readonly startPos: number;
  /** The latest pointer position, which a scroll re-applies with the pointer held still. */
  lastPos: number;
  /** Set once the press travels past the threshold and the row lifts. */
  lift: SortLift | null;
  readonly cleanup: () => void;
}

/**
 * The single owner of live sorting in one rendered list. Pressing a row and moving lifts it to follow the pointer,
 * while the other items of its group slide aside to open the slot it would take; the elements under a row fold away
 * while it is dragged. List renders wait while an item is lifted and until its new order is saved, so neither the
 * gesture nor the dropped layout is torn down midway.
 */
export class LiveListSorter {
  #entries: SortEntry[] = [];
  /** Rows already listening for presses; a row attached again only replaces its entry. */
  readonly #listening = new WeakSet<HTMLElement>();
  #gesture: SortGesture | null = null;
  #settling = false;
  #deferredRender: (() => void) | null = null;
  readonly #axis: AxisGeometry;

  constructor(private readonly deps: LiveListSorterDeps) {
    this.#axis = AXES[deps.axis ?? 'y'];
  }

  /** An item is lifted, or its drop is still saving. */
  get isDragging(): boolean {
    return this.#gesture?.lift != null || this.#settling;
  }

  /** Holds a list render while an item is dragged, running the latest one when the drag ends. */
  deferRender(render: () => void): boolean {
    if (!this.isDragging) return false;
    this.#deferredRender = render;
    return true;
  }

  /** Starts a list render; rows from the previous render are gone, so a press on one is dropped. */
  beginRender(): void {
    this.#endGesture();
    this.#entries = [];
  }

  /**
   * Makes an item sortable by pressing its row (`block[0]`). Attaching a row that is already sortable replaces its
   * entry, so a list that keeps its row nodes across renders re-registers them instead of rebuilding them.
   */
  attach(block: readonly [HTMLElement, ...HTMLElement[]], row: LiveSortRow): void {
    const rowEl = block[0];
    this.#entries = this.#entries.filter(entry => entry.block[0] !== rowEl);
    this.#entries.push({ row, block });
    for (const el of block) el.classList.add(ITEM_CLASS);
    if (this.#listening.has(rowEl)) return;
    this.#listening.add(rowEl);
    const { ignoreSelector } = this.deps;
    // Popout windows have their own Element constructor.
    const ElementConstructor = rowEl.ownerDocument.defaultView?.Element ?? Element;
    rowEl.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || this.#gesture || this.#settling) return;
      if (this.deps.canStart && !this.deps.canStart()) return;
      if (ignoreSelector && event.target instanceof ElementConstructor && event.target.closest(ignoreSelector)) return;
      const entry = this.#entries.find(candidate => candidate.block[0] === rowEl);
      if (entry) this.#press(entry, event);
    });
  }

  /** Stops sorting a row that left the list; a press on it ends. */
  detach(rowEl: HTMLElement): void {
    this.#entries = this.#entries.filter(entry => entry.block[0] !== rowEl);
    if (this.#gesture?.entry.block[0] === rowEl) this.#cancel();
  }

  /** Cancels a lifted drag, as Escape does; returns whether one was lifted. */
  cancelDrag(): boolean {
    const gesture = this.#gesture;
    if (!gesture?.lift) return false;
    this.#cancel();
    // The button is still held; its release ends the cancelled drag, not a click on the row.
    swallowClickAfterRelease(gesture.doc);
    return true;
  }

  /** Ends any drag for teardown; a held render is discarded rather than run. */
  dispose(): void {
    this.#deferredRender = null;
    this.#endGesture();
  }

  /** Cancels any drag, restoring the list as rendered. */
  #cancel(): void {
    const lifted = this.#gesture?.lift != null;
    this.#endGesture();
    if (lifted) this.#runDeferredRender();
  }

  #press(entry: SortEntry, event: PointerEvent): void {
    const doc = entry.block[0].ownerDocument;
    const win = doc.defaultView;
    const onMove = (moveEvent: PointerEvent): void => this.#move(moveEvent);
    const onUp = (): void => this.#drop();
    const onCancel = (): void => this.#cancel();
    const onScroll = (): void => {
      const gesture = this.#gesture;
      if (gesture?.lift) this.#follow(gesture, gesture.lift);
    };
    const onKey = (keyEvent: KeyboardEvent): void => {
      if (keyEvent.key !== 'Escape' || !this.#gesture?.lift) return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      this.#cancel();
      // The button is still held; its release ends the cancelled drag, not a click on the row.
      swallowClickAfterRelease(doc);
    };
    doc.addEventListener('pointermove', onMove, true);
    doc.addEventListener('pointerup', onUp, true);
    doc.addEventListener('pointercancel', onCancel, true);
    doc.addEventListener('keydown', onKey, true);
    doc.addEventListener('scroll', onScroll, true);
    win?.addEventListener('blur', onCancel);
    this.#gesture = {
      entry,
      doc,
      startPos: this.#axis.pointer(event),
      lastPos: this.#axis.pointer(event),
      lift: null,
      cleanup: () => {
        doc.removeEventListener('pointermove', onMove, true);
        doc.removeEventListener('pointerup', onUp, true);
        doc.removeEventListener('pointercancel', onCancel, true);
        doc.removeEventListener('keydown', onKey, true);
        doc.removeEventListener('scroll', onScroll, true);
        win?.removeEventListener('blur', onCancel);
      },
    };
  }

  #move(event: PointerEvent): void {
    const gesture = this.#gesture;
    if (!gesture) return;
    gesture.lastPos = this.#axis.pointer(event);
    let lift = gesture.lift;
    if (!lift) {
      if (Math.abs(gesture.lastPos - gesture.startPos) < DRAG_THRESHOLD_PX) return;
      lift = this.#lift(gesture);
      if (!lift) {
        this.#endGesture();
        return;
      }
    }
    event.preventDefault();
    this.#follow(gesture, lift);
  }

  /** Moves the lifted row under the pointer and slides the others to open the slot it would take. */
  #follow(gesture: SortGesture, lift: SortLift): void {
    const axis = this.#axis;
    const scrolled = lift.listStart - axis.start(lift.list.getBoundingClientRect())
      + axis.scroll(lift.list) - lift.startScroll;
    const offset = Math.min(lift.maxOffset, Math.max(lift.minOffset, gesture.lastPos - gesture.startPos + scrolled));
    this.#setOffset(gesture.entry.block, offset);
    // A neighbour moves away once the card's leading edge covers part of it, so the card never rests on it.
    const start = lift.dragged.start + offset;
    const end = start + lift.dragged.size;
    const displacedBefore = lift.others.slice(0, lift.draggedIndex)
      .filter(item => start < item.start + item.size * (1 - DISPLACE_FRACTION)).length;
    const displacedAfter = lift.others.slice(lift.draggedIndex)
      .filter(item => end > item.start + item.size * DISPLACE_FRACTION).length;
    const targetIndex = lift.draggedIndex - displacedBefore + displacedAfter;
    lift.targetIndex = targetIndex;
    const { draggedIndex, dragged } = lift;
    lift.others.forEach((item, index) => {
      this.#setOffset(item.entry.block, shiftOf(index, draggedIndex, targetIndex, dragged.size + lift.gap));
    });
  }

  /** Lifts the pressed item; null when it has nothing to sort among. */
  #lift(gesture: SortGesture): SortLift | null {
    const [rowEl, ...folded] = gesture.entry.block;
    const list = rowEl.parentElement;
    if (!list) return null;
    const axis = this.#axis;
    const group = this.#entries.filter(entry => (
      entry.row.group === gesture.entry.row.group && entry.block[0].parentElement === list
    ));
    // Rows kept across renders register in attach order, which a reorder leaves behind their layout order.
    group.sort((a, b) => (
      a.block[0].compareDocumentPosition(b.block[0]) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    ));
    // A row re-attached since the press has a new entry; one detached since then cannot lift.
    const draggedIndex = group.findIndex(entry => entry.block[0] === rowEl);
    if (group.length < 2 || draggedIndex < 0) return null;
    // Folding keeps the list's scroll height, so a list scrolled near its end is not pulled back under the pointer.
    // The space is held inside the scrolled content: padding on the list would let it grow past its section.
    const foldedSize = folded.reduce((sum, el) => sum + axis.size(el.getBoundingClientRect()), 0);
    let spacer: HTMLElement | null = null;
    if (foldedSize > 0) {
      spacer = list.createDiv({ cls: SPACER_CLASS, attr: { 'aria-hidden': 'true' } });
      spacer.style[axis.sizeStyle] = `${foldedSize}px`;
    }
    for (const el of folded) el.classList.add(FOLDED_CLASS);
    list.classList.add(SORTING_CLASS);
    rowEl.classList.add(LIFTED_CLASS);
    const items = group.map(entry => measure(entry, axis));
    const dragged = items[draggedIndex];
    const first = items[0];
    const last = items[items.length - 1];
    // A press on row text may have started a selection before the row lifted.
    rowEl.ownerDocument.getSelection()?.removeAllRanges();
    gesture.lift = {
      list,
      listStart: axis.start(list.getBoundingClientRect()),
      startScroll: axis.scroll(list),
      spacer,
      dragged,
      others: items.filter(item => item !== dragged),
      draggedIndex,
      gap: Math.max(0, items[1].start - (items[0].start + items[0].size)),
      minOffset: first.start - dragged.start,
      maxOffset: (last.start + last.size) - (dragged.start + dragged.size),
      targetIndex: draggedIndex,
    };
    this.deps.onDragStart?.();
    return gesture.lift;
  }

  #drop(): void {
    const gesture = this.#gesture;
    const lift = gesture?.lift;
    if (!gesture || !lift) {
      this.#endGesture();
      return;
    }
    // The release ends a drag, not a click on the row.
    swallowNextClick(gesture.doc);

    const { others, draggedIndex, targetIndex } = lift;
    if (targetIndex === draggedIndex) {
      this.#cancel();
      return;
    }
    // The dragged row settles into its slot while the order saves.
    const between = targetIndex > draggedIndex
      ? others.slice(draggedIndex, targetIndex)
      : others.slice(targetIndex, draggedIndex);
    const distance = between.reduce((sum, item) => sum + item.size + lift.gap, 0);
    this.#setOffset(gesture.entry.block, targetIndex > draggedIndex ? distance : -distance);
    gesture.entry.block[0].classList.remove(LIFTED_CLASS);
    gesture.cleanup();
    this.#gesture = null;
    this.#settling = true;
    const target = others[Math.min(targetIndex, others.length - 1)];
    const placement: SortPlacement = targetIndex < others.length ? 'before' : 'after';
    void this.deps.onDrop(gesture.entry.row.id, target.entry.row.id, placement)
      .finally(() => {
        this.#settling = false;
        // A failed save may publish no render, so the rows are put back before any held render replaces them.
        this.#resetLayout(gesture.entry, lift);
        this.#runDeferredRender();
      });
  }

  #endGesture(): void {
    const gesture = this.#gesture;
    if (!gesture) return;
    gesture.cleanup();
    this.#gesture = null;
    if (gesture.lift) this.#resetLayout(gesture.entry, gesture.lift);
  }

  #resetLayout(entry: SortEntry, lift: SortLift): void {
    lift.list.classList.remove(SORTING_CLASS);
    entry.block[0].classList.remove(LIFTED_CLASS);
    for (const el of entry.block) el.classList.remove(FOLDED_CLASS);
    lift.spacer?.remove();
    for (const item of [lift.dragged, ...lift.others]) this.#setOffset(item.entry.block, 0);
  }

  #setOffset(block: readonly HTMLElement[], offset: number): void {
    for (const el of block) el.style.transform = offset === 0 ? '' : `${this.#axis.translate}(${offset}px)`;
  }

  #runDeferredRender(): void {
    const render = this.#deferredRender;
    this.#deferredRender = null;
    render?.();
  }
}

/** Swallows the click the browser fires for the pointer release being handled now. */
function swallowNextClick(doc: Document): void {
  const swallow = (event: MouseEvent): void => {
    event.stopPropagation();
    event.preventDefault();
  };
  doc.addEventListener('click', swallow, true);
  doc.defaultView?.setTimeout(() => doc.removeEventListener('click', swallow, true), 0);
}

/** Swallows the click of the next pointer release; a cancelled pointer fires no click, so it stops waiting. */
function swallowClickAfterRelease(doc: Document): void {
  const onUp = (): void => {
    stop();
    swallowNextClick(doc);
  };
  const stop = (): void => {
    doc.removeEventListener('pointerup', onUp, true);
    doc.removeEventListener('pointercancel', stop, true);
  };
  doc.addEventListener('pointerup', onUp, true);
  doc.addEventListener('pointercancel', stop, true);
}

/** Reads positions, sizes, scroll and transforms along one sort axis. */
interface AxisGeometry {
  pointer(event: PointerEvent): number;
  start(rect: DOMRect): number;
  end(rect: DOMRect): number;
  size(rect: DOMRect): number;
  scroll(el: HTMLElement): number;
  readonly sizeStyle: 'height' | 'width';
  readonly translate: 'translateX' | 'translateY';
}

const AXES: Record<SortAxis, AxisGeometry> = {
  x: {
    pointer: event => event.clientX,
    start: rect => rect.left,
    end: rect => rect.right,
    size: rect => rect.width,
    scroll: el => el.scrollLeft,
    sizeStyle: 'width',
    translate: 'translateX',
  },
  y: {
    pointer: event => event.clientY,
    start: rect => rect.top,
    end: rect => rect.bottom,
    size: rect => rect.height,
    scroll: el => el.scrollTop,
    sizeStyle: 'height',
    translate: 'translateY',
  },
};

function measure(entry: SortEntry, axis: AxisGeometry): SortItem {
  const visible = entry.block.filter(el => !el.classList.contains(FOLDED_CLASS));
  const start = axis.start(visible[0].getBoundingClientRect());
  const end = axis.end(visible[visible.length - 1].getBoundingClientRect());
  return { entry, start, size: end - start };
}

/** How far another item moves to open the dragged one's slot: by the dragged pitch, toward its origin. */
function shiftOf(index: number, draggedIndex: number, targetIndex: number, pitch: number): number {
  if (index >= draggedIndex && index < targetIndex) return -pitch;
  if (index < draggedIndex && index >= targetIndex) return pitch;
  return 0;
}
