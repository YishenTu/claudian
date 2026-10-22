/** Where a dragged session lands; the target defines its pin state and project. */
export type SessionDropTarget =
  | { kind: 'pinned' }
  | { kind: 'project'; projectId: string }
  | { kind: 'sessions' };

/** Marks a drag as Claudian sessions so other drags (files, text) are never accepted. */
const SESSION_DRAG_MIME = 'application/x-claudian-sessions';
const DROP_TARGET_ATTRIBUTE = 'data-session-drop-target';
const ACTIVE_TARGET_CLASS = 'claudian-session-drop-target--active';
const PINNED_DROP_ZONE_CLASS = 'claudian-session-pinned-drop-zone';

function targetKey(target: SessionDropTarget): string {
  return target.kind === 'project' ? `project:${target.projectId}` : target.kind;
}

export interface SessionDragDeps {
  /** Moves the dragged sessions to the drop target. */
  onDrop(conversationIds: readonly string[], target: SessionDropTarget): void;
  /** A drag began; hover-only presentation such as the metadata popover should close. */
  onDragStart(): void;
}

/**
 * The single owner of a session drag in one rendered list: the dragged sessions, the hovered drop target,
 * and when the Pinned placeholder shows. Rows and targets re-rendered during a drag keep working because they
 * read this state; highlights live only on the current DOM.
 */
export class SessionDrag {
  #draggedIds: readonly string[] | null = null;
  #container: HTMLElement | null = null;
  #revealTimer: number | null = null;
  #cleanup: (() => void) | null = null;

  constructor(private readonly deps: SessionDragDeps) {}

  get isDragging(): boolean {
    return this.#draggedIds !== null;
  }

  /** Starts a list render into `container`; the new DOM carries no highlight. */
  beginRender(container: HTMLElement): void {
    this.#container = container;
  }

  /** Makes a row draggable; `getIds` resolves the dragged sessions when the drag starts. */
  attachSource(item: HTMLElement, getIds: () => readonly string[]): void {
    item.setAttribute('draggable', 'true');
    item.addEventListener('dragstart', (event) => {
      // An inline title editor inside the row keeps native text dragging.
      if (event.target !== item || !event.dataTransfer) return;
      const ids = getIds();
      if (ids.length === 0) {
        event.preventDefault();
        return;
      }
      this.end();
      event.dataTransfer.setData(SESSION_DRAG_MIME, JSON.stringify(ids));
      event.dataTransfer.effectAllowed = 'move';
      this.#draggedIds = ids;
      this.deps.onDragStart();
      this.#watchDragEnd(item.ownerDocument);
      // Changing layout inside dragstart can cancel the native drag, so the zone appears a task later.
      const window = item.ownerDocument.defaultView;
      this.#revealTimer = window?.setTimeout(() => {
        this.#revealTimer = null;
        this.#setPinnedZonesVisible(true);
      }, 0) ?? null;
    });
    item.addEventListener('dragend', () => this.end());
  }

  /** Accepts session drops on `el`. Several elements may share one target, such as a project row and body. */
  attachTarget(el: HTMLElement, target: SessionDropTarget): void {
    const key = targetKey(target);
    el.setAttribute(DROP_TARGET_ATTRIBUTE, key);
    const accept = (event: DragEvent): boolean => {
      if (!this.isDragging || !event.dataTransfer?.types.includes(SESSION_DRAG_MIME)) return false;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      this.#highlight(key);
      return true;
    };
    el.addEventListener('dragenter', accept);
    el.addEventListener('dragover', accept);
    el.addEventListener('dragleave', (event) => {
      const next = event.relatedTarget;
      if (next instanceof Node && this.#targetsOf(key).some(targetEl => targetEl.contains(next))) return;
      this.#highlight(null, key);
    });
    el.addEventListener('drop', (event) => {
      const ids = this.#draggedIds;
      if (!ids || !event.dataTransfer?.types.includes(SESSION_DRAG_MIME)) return;
      event.preventDefault();
      event.stopPropagation();
      this.end();
      this.deps.onDrop(ids, target);
    });
  }

  /**
   * Makes the Pinned section of a list with nothing pinned a drop target that shows only while a drag is in
   * progress, from a task after the drag starts until it ends.
   */
  attachPinnedPlaceholder(section: HTMLElement): void {
    section.addClass(PINNED_DROP_ZONE_CLASS);
    section.hidden = !this.isDragging || this.#revealTimer !== null;
    this.attachTarget(section, { kind: 'pinned' });
  }

  /** Ends any drag: drops its sessions, highlight, and temporary zone. */
  end(): void {
    if (this.#revealTimer !== null) {
      this.#container?.ownerDocument.defaultView?.clearTimeout(this.#revealTimer);
      this.#revealTimer = null;
    }
    this.#cleanup?.();
    this.#cleanup = null;
    if (!this.#draggedIds) return;
    this.#draggedIds = null;
    this.#highlight(null);
    this.#setPinnedZonesVisible(false);
  }

  /**
   * A row re-rendered mid-drag no longer receives its own dragend, so the document also ends the drag
   * on any drop, dragend, or the next pointer press (none occur while a native drag is in progress).
   */
  #watchDragEnd(doc: Document): void {
    const end = (): void => this.end();
    doc.addEventListener('drop', end);
    doc.addEventListener('dragend', end, true);
    doc.addEventListener('pointerdown', end, true);
    this.#cleanup = () => {
      doc.removeEventListener('drop', end);
      doc.removeEventListener('dragend', end, true);
      doc.removeEventListener('pointerdown', end, true);
    };
  }

  #targetsOf(key: string | null): HTMLElement[] {
    const container = this.#container;
    if (!container) return [];
    return [...container.querySelectorAll<HTMLElement>(`[${DROP_TARGET_ATTRIBUTE}]`)]
      .filter(el => key === null || el.getAttribute(DROP_TARGET_ATTRIBUTE) === key);
  }

  /** Highlights the target `key` alone, or clears the highlight (only of `leaving`, when given). */
  #highlight(key: string | null, leaving?: string): void {
    for (const el of this.#targetsOf(null)) {
      const elKey = el.getAttribute(DROP_TARGET_ATTRIBUTE);
      if (leaving !== undefined && elKey !== leaving) continue;
      el.classList.toggle(ACTIVE_TARGET_CLASS, key !== null && elKey === key);
    }
  }

  #setPinnedZonesVisible(visible: boolean): void {
    this.#container?.querySelectorAll<HTMLElement>(`.${PINNED_DROP_ZONE_CLASS}`).forEach((zone) => {
      zone.hidden = !visible;
    });
  }
}
