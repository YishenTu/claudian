import type { ProjectPlacement } from '@/features/chat/projects/projectOrder';

/** Pointer travel before a press on a project row becomes a drag, so clicks still toggle the project. */
const DRAG_THRESHOLD_PX = 4;
/** Row controls that keep their own pointer behavior. */
const ROW_ACTION_SELECTOR = '.claudian-session-group-menu-action, .claudian-session-group-new-action';
const SORTING_CLASS = 'claudian-project-sorting';
const LIFTED_CLASS = 'claudian-project-lifted';
const FOLDED_CLASS = 'claudian-project-sort-folded';
const SPACER_CLASS = 'claudian-project-sort-spacer';
/** How much of a neighbour the dragged card's leading edge covers before the neighbour moves away. */
const DISPLACE_FRACTION = 0.3;

/** A project row as a sortable item; projects sort only among those of their pin state in the same list. */
export interface ProjectSortRow {
  readonly projectId: string;
  readonly isPinned: boolean;
}

export interface ProjectSorterDeps {
  /**
   * Saves the dragged project next to the target, reporting its own failure; the sorter holds the dropped layout
   * until it settles.
   */
  onDrop(projectId: string, targetId: string, placement: ProjectPlacement): Promise<void>;
  /** A drag began; hover-only presentation such as the metadata popover should close. */
  onDragStart(): void;
}

/** A project's row and, when expanded, its member list. */
interface SortEntry {
  readonly row: ProjectSortRow;
  readonly block: readonly [HTMLElement, ...HTMLElement[]];
}

interface SortItem {
  readonly entry: SortEntry;
  readonly top: number;
  readonly height: number;
}

interface SortLift {
  readonly list: HTMLElement;
  readonly startScroll: number;
  /** Holds the folded members' height at the end of the list's content while they are folded. */
  readonly spacer: HTMLElement | null;
  readonly dragged: SortItem;
  /** The other projects of the dragged one's group, in list order. */
  readonly others: readonly SortItem[];
  readonly draggedIndex: number;
  readonly minOffset: number;
  readonly maxOffset: number;
  targetIndex: number;
}

interface SortGesture {
  readonly entry: SortEntry;
  readonly doc: Document;
  readonly startY: number;
  /** Set once the press travels past the threshold and the row lifts. */
  lift: SortLift | null;
  readonly cleanup: () => void;
}

/**
 * The single owner of live project sorting in one rendered list. Pressing a project row and moving lifts it to follow the
 * pointer, while the other projects of its group slide aside to open the slot it would take; an
 * expanded project folds to its row while dragged. List renders wait while a project is lifted and until its new
 * order is saved, so neither the gesture nor the dropped layout is torn down midway.
 */
export class ProjectSorter {
  #entries: SortEntry[] = [];
  #gesture: SortGesture | null = null;
  #settling = false;
  #deferredRender: (() => void) | null = null;

  constructor(private readonly deps: ProjectSorterDeps) {}

  /** A project is lifted, or its drop is still saving. */
  get isDragging(): boolean {
    return this.#gesture?.lift != null || this.#settling;
  }

  /** Holds a list render while a project is dragged, running the latest one when the drag ends. */
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

  /** Makes a project sortable by pressing its row (`block[0]`). */
  attach(block: readonly [HTMLElement, ...HTMLElement[]], row: ProjectSortRow): void {
    const entry: SortEntry = { row, block };
    this.#entries.push(entry);
    // Popout windows have their own Element constructor.
    const ElementConstructor = block[0].ownerDocument.defaultView?.Element ?? Element;
    block[0].addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || this.#gesture || this.#settling) return;
      if (event.target instanceof ElementConstructor && event.target.closest(ROW_ACTION_SELECTOR)) return;
      this.#press(entry, event);
    });
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
    const onKey = (keyEvent: KeyboardEvent): void => {
      if (keyEvent.key !== 'Escape' || !this.#gesture?.lift) return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      this.#cancel();
      // The button is still held; its release ends the cancelled drag, not a click on the row's toggle.
      swallowClickAfterRelease(doc);
    };
    doc.addEventListener('pointermove', onMove, true);
    doc.addEventListener('pointerup', onUp, true);
    doc.addEventListener('pointercancel', onCancel, true);
    doc.addEventListener('keydown', onKey, true);
    win?.addEventListener('blur', onCancel);
    this.#gesture = {
      entry,
      doc,
      startY: event.clientY,
      lift: null,
      cleanup: () => {
        doc.removeEventListener('pointermove', onMove, true);
        doc.removeEventListener('pointerup', onUp, true);
        doc.removeEventListener('pointercancel', onCancel, true);
        doc.removeEventListener('keydown', onKey, true);
        win?.removeEventListener('blur', onCancel);
      },
    };
  }

  #move(event: PointerEvent): void {
    const gesture = this.#gesture;
    if (!gesture) return;
    let lift = gesture.lift;
    if (!lift) {
      if (Math.abs(event.clientY - gesture.startY) < DRAG_THRESHOLD_PX) return;
      lift = this.#lift(gesture);
      if (!lift) {
        this.#endGesture();
        return;
      }
    }
    event.preventDefault();
    const scrolled = lift.list.scrollTop - lift.startScroll;
    const offset = Math.min(lift.maxOffset, Math.max(lift.minOffset, event.clientY - gesture.startY + scrolled));
    setOffset(gesture.entry.block, offset);
    // A neighbour moves away once the card's leading edge covers part of it, so the card never rests on it.
    const top = lift.dragged.top + offset;
    const bottom = top + lift.dragged.height;
    const displacedAbove = lift.others.slice(0, lift.draggedIndex)
      .filter(item => top < item.top + item.height * (1 - DISPLACE_FRACTION)).length;
    const displacedBelow = lift.others.slice(lift.draggedIndex)
      .filter(item => bottom > item.top + item.height * DISPLACE_FRACTION).length;
    const targetIndex = lift.draggedIndex - displacedAbove + displacedBelow;
    lift.targetIndex = targetIndex;
    const { draggedIndex, dragged } = lift;
    lift.others.forEach((item, index) => {
      setOffset(item.entry.block, shiftOf(index, draggedIndex, targetIndex, dragged.height));
    });
  }

  /** Lifts the pressed project; null when it has nothing to sort among. */
  #lift(gesture: SortGesture): SortLift | null {
    const [rowEl, ...folded] = gesture.entry.block;
    const list = rowEl.parentElement;
    if (!list) return null;
    const group = this.#entries.filter(entry => (
      entry.row.isPinned === gesture.entry.row.isPinned && entry.block[0].parentElement === list
    ));
    if (group.length < 2) return null;
    // Folding keeps the list's scroll height, so a list scrolled near its end is not pulled back under the pointer.
    // The space is held inside the scrolled content: padding on the list would let it grow past its section.
    const foldedHeight = folded.reduce((sum, el) => sum + el.getBoundingClientRect().height, 0);
    let spacer: HTMLElement | null = null;
    if (foldedHeight > 0) {
      spacer = list.createDiv({ cls: SPACER_CLASS, attr: { 'aria-hidden': 'true' } });
      spacer.style.height = `${foldedHeight}px`;
    }
    for (const el of folded) el.classList.add(FOLDED_CLASS);
    list.classList.add(SORTING_CLASS);
    rowEl.classList.add(LIFTED_CLASS);
    const items = group.map(measure);
    const draggedIndex = group.indexOf(gesture.entry);
    const dragged = items[draggedIndex];
    const first = items[0];
    const last = items[items.length - 1];
    gesture.lift = {
      list,
      startScroll: list.scrollTop,
      spacer,
      dragged,
      others: items.filter(item => item !== dragged),
      draggedIndex,
      minOffset: first.top - dragged.top,
      maxOffset: (last.top + last.height) - (dragged.top + dragged.height),
      targetIndex: draggedIndex,
    };
    this.deps.onDragStart();
    return gesture.lift;
  }

  #drop(): void {
    const gesture = this.#gesture;
    const lift = gesture?.lift;
    if (!gesture || !lift) {
      this.#endGesture();
      return;
    }
    // The release ends a drag, not a click on the row's toggle.
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
    const distance = between.reduce((sum, item) => sum + item.height, 0);
    setOffset(gesture.entry.block, targetIndex > draggedIndex ? distance : -distance);
    gesture.entry.block[0].classList.remove(LIFTED_CLASS);
    gesture.cleanup();
    this.#gesture = null;
    this.#settling = true;
    const target = others[Math.min(targetIndex, others.length - 1)];
    const placement: ProjectPlacement = targetIndex < others.length ? 'before' : 'after';
    void this.deps.onDrop(gesture.entry.row.projectId, target.entry.row.projectId, placement)
      .finally(() => {
        this.#settling = false;
        // A failed save may publish no render, so the rows are put back before any held render replaces them.
        resetLayout(gesture.entry, lift);
        this.#runDeferredRender();
      });
  }

  #endGesture(): void {
    const gesture = this.#gesture;
    if (!gesture) return;
    gesture.cleanup();
    this.#gesture = null;
    if (gesture.lift) resetLayout(gesture.entry, gesture.lift);
  }

  #runDeferredRender(): void {
    const render = this.#deferredRender;
    this.#deferredRender = null;
    render?.();
  }
}

function resetLayout(entry: SortEntry, lift: SortLift): void {
  lift.list.classList.remove(SORTING_CLASS);
  entry.block[0].classList.remove(LIFTED_CLASS);
  for (const el of entry.block) el.classList.remove(FOLDED_CLASS);
  lift.spacer?.remove();
  for (const item of [lift.dragged, ...lift.others]) setOffset(item.entry.block, 0);
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

function measure(entry: SortEntry): SortItem {
  const visible = entry.block.filter(el => !el.classList.contains(FOLDED_CLASS));
  const top = visible[0].getBoundingClientRect().top;
  const bottom = visible[visible.length - 1].getBoundingClientRect().bottom;
  return { entry, top, height: bottom - top };
}

/** How far another project moves to open the dragged one's slot: by the dragged height, toward its origin. */
function shiftOf(index: number, draggedIndex: number, targetIndex: number, height: number): number {
  if (index >= draggedIndex && index < targetIndex) return -height;
  if (index < draggedIndex && index >= targetIndex) return height;
  return 0;
}

function setOffset(block: readonly HTMLElement[], offset: number): void {
  for (const el of block) el.style.transform = offset === 0 ? '' : `translateY(${offset}px)`;
}
