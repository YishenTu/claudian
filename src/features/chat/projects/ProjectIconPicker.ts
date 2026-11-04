import { getIconIds, type Keymap, Scope, setIcon } from 'obsidian';

import { DEFAULT_PROJECT_ICON, projectIconLabel } from '@/features/chat/projects/projectIcon';
import { t } from '@/i18n/i18n';

/** Matches the grid's CSS column count, so Up and Down move by one row. */
const COLUMNS = 8;

export interface ProjectIconPickerOptions {
  keymap: Pick<Keymap, 'pushScope' | 'popScope'>;
  /** The chosen icon id; undefined is the default folder. */
  value: string | undefined;
}

/**
 * An icon button that opens a small panel of Obsidian's icons to pick from, with search and a default-folder choice.
 * Escape, a pick, or focus leaving closes the panel.
 */
export class ProjectIconPicker {
  readonly el: HTMLElement;
  #value: string | undefined;
  readonly #trigger: HTMLButtonElement;
  #panel: HTMLElement | null = null;
  #grid: HTMLElement | null = null;
  #status: HTMLElement | null = null;
  readonly #scope = new Scope();
  #removeOutsideListener: (() => void) | null = null;

  constructor(parent: HTMLElement, private readonly options: ProjectIconPickerOptions) {
    this.#value = options.value;
    this.el = parent.createDiv({ cls: 'claudian-project-icon-picker' });
    this.#trigger = this.el.createEl('button', {
      cls: 'claudian-project-icon-trigger clickable-icon',
      attr: { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
    });
    this.#trigger.addEventListener('click', () => {
      if (this.#panel) this.close(true);
      else this.#open();
    });
    this.#scope.register(null, 'Escape', () => {
      this.close(true);
      return false;
    });
    this.el.addEventListener('focusout', (event) => {
      // Popout windows have their own Node constructor, so test containment rather than `instanceof`.
      const next = event.relatedTarget as Node | null;
      if (next && !this.el.contains(next)) this.close(false);
    });
    this.#renderTrigger();
  }

  get value(): string | undefined {
    return this.#value;
  }

  setDisabled(disabled: boolean): void {
    if (disabled) this.close(false);
    this.#trigger.disabled = disabled;
  }

  close(restoreFocus: boolean): void {
    if (!this.#panel) return;
    this.options.keymap.popScope(this.#scope);
    this.#removeOutsideListener?.();
    this.#removeOutsideListener = null;
    this.#panel.remove();
    this.#panel = this.#grid = this.#status = null;
    this.#trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) this.#trigger.focus();
  }

  #renderTrigger(): void {
    const label = this.#value ? projectIconLabel(this.#value) : t('chat.projects.editor.iconDefault');
    this.#trigger.setAttribute('aria-label', t('chat.projects.editor.iconButton', { icon: label }));
    setIcon(this.#trigger, this.#value ?? DEFAULT_PROJECT_ICON);
  }

  #open(): void {
    const panel = this.#panel = this.el.createDiv({
      cls: 'claudian-project-icon-panel',
      attr: { role: 'dialog', 'aria-label': t('chat.projects.editor.iconPicker') },
    });
    const search = panel.createEl('input', {
      cls: 'claudian-project-icon-search',
      attr: {
        type: 'search',
        'aria-label': t('chat.projects.editor.iconSearch'),
        placeholder: t('chat.projects.editor.iconSearch'),
      },
    });
    this.#grid = panel.createDiv({ cls: 'claudian-project-icon-grid' });
    this.#status = panel.createDiv({ cls: 'claudian-project-icon-status', attr: { 'aria-live': 'polite' } });
    search.addEventListener('input', () => this.#renderGrid(search.value));
    search.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.#cells()[0]?.focus();
      } else if (event.key === 'Enter') {
        // Enter picks the first match instead of saving the project.
        event.preventDefault();
        this.#cells()[0]?.click();
      }
    });
    this.#grid.addEventListener('keydown', event => this.#moveFocus(event));
    this.#renderGrid('');

    const doc = this.el.ownerDocument;
    const onPointerDown = (event: PointerEvent) => {
      if (!this.el.contains(event.target as Node | null)) this.close(false);
    };
    doc.addEventListener('pointerdown', onPointerDown, true);
    this.#removeOutsideListener = () => doc.removeEventListener('pointerdown', onPointerDown, true);
    this.options.keymap.pushScope(this.#scope);
    this.#trigger.setAttribute('aria-expanded', 'true');
    search.focus();
  }

  #renderGrid(query: string): void {
    const grid = this.#grid;
    const status = this.#status;
    if (!grid || !status) return;
    grid.empty();
    const needle = query.trim().toLowerCase();
    const matches = getIconIds()
      .filter(id => projectIconLabel(id).toLowerCase().includes(needle))
      .sort((a, b) => projectIconLabel(a).localeCompare(projectIconLabel(b)));
    const choices: Array<string | undefined> = [...(needle ? [] : [undefined]), ...matches];
    const selected = choices.includes(this.#value) ? this.#value : choices[0];
    for (const iconId of choices) {
      const cell = grid.createEl('button', {
        cls: 'claudian-project-icon-cell clickable-icon',
        attr: {
          type: 'button',
          'aria-label': iconId ? projectIconLabel(iconId) : t('chat.projects.editor.iconDefault'),
          'aria-pressed': iconId === this.#value ? 'true' : 'false',
          // One tab stop; the arrow keys move within the grid.
          tabindex: iconId === selected ? '0' : '-1',
        },
      });
      setIcon(cell, iconId ?? DEFAULT_PROJECT_ICON);
      cell.addEventListener('click', () => this.#pick(iconId));
    }
    status.setText(matches.length === 0 ? t('chat.projects.editor.iconNoMatches') : '');
  }

  #cells(): HTMLButtonElement[] {
    return Array.from(this.#grid?.querySelectorAll<HTMLButtonElement>('.claudian-project-icon-cell') ?? []);
  }

  #moveFocus(event: KeyboardEvent): void {
    const cells = this.#cells();
    const index = cells.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    const steps: Record<string, number> = {
      ArrowLeft: -1, ArrowRight: 1, ArrowUp: -COLUMNS, ArrowDown: COLUMNS,
      Home: -index, End: cells.length - 1 - index,
    };
    const step = steps[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const next = cells[Math.min(Math.max(index + step, 0), cells.length - 1)];
    if (event.key === 'ArrowUp' && index < COLUMNS) {
      this.#panel?.querySelector<HTMLInputElement>('.claudian-project-icon-search')?.focus();
      return;
    }
    if (!next) return;
    for (const cell of cells) cell.tabIndex = cell === next ? 0 : -1;
    next.focus();
  }

  #pick(iconId: string | undefined): void {
    this.#value = iconId;
    this.#renderTrigger();
    this.close(true);
  }
}
