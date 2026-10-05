export interface CollapsibleState {
  isExpanded: boolean;
}

export interface CollapsibleOptions {
  /** Initial expanded state (default: false) */
  initiallyExpanded?: boolean;
  /** Callback when state changes */
  onToggle?: (isExpanded: boolean) => void;
  /** Runs once, before the content is first shown (during setup when initially expanded). */
  onFirstExpand?: () => void;
  /** Base label for aria-label (will append "click to expand/collapse") */
  baseAriaLabel?: string;
}

/**
 * Makes a non-native header a keyboard-operable disclosure for its content.
 *
 * Owns the header's button role and focusability, click and Enter/Space
 * toggling, aria-expanded/aria-label, the wrapper's `expanded` class and the
 * content's visibility. `state` is mutated to mirror the expanded state.
 */
export function setupCollapsible(
  wrapperEl: HTMLElement,
  headerEl: HTMLElement,
  contentEl: HTMLElement,
  state: CollapsibleState,
  options: CollapsibleOptions = {}
): void {
  const { initiallyExpanded = false, onToggle, baseAriaLabel } = options;
  let onFirstExpand = options.onFirstExpand;

  headerEl.setAttribute('tabindex', '0');
  headerEl.setAttribute('role', 'button');

  const applyState = (isExpanded: boolean) => {
    if (isExpanded) {
      onFirstExpand?.();
      onFirstExpand = undefined;
    }
    state.isExpanded = isExpanded;
    if (isExpanded) {
      wrapperEl.addClass('expanded');
      contentEl.removeClass('claudian-hidden');
    } else {
      wrapperEl.removeClass('expanded');
      contentEl.addClass('claudian-hidden');
    }
    headerEl.setAttribute('aria-expanded', String(isExpanded));
    if (baseAriaLabel) {
      const action = isExpanded ? 'click to collapse' : 'click to expand';
      headerEl.setAttribute('aria-label', `${baseAriaLabel} - ${action}`);
    }
  };

  applyState(initiallyExpanded);

  const toggleExpand = () => {
    applyState(!state.isExpanded);
    onToggle?.(state.isExpanded);
  };

  headerEl.addEventListener('click', toggleExpand);
  headerEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleExpand();
    }
  });
}

/**
 * Collapse a collapsible element and sync state.
 * Use this when programmatically collapsing (e.g., on finalize).
 */
export function collapseElement(
  wrapperEl: HTMLElement,
  headerEl: HTMLElement,
  contentEl: HTMLElement,
  state: CollapsibleState
): void {
  state.isExpanded = false;
  wrapperEl.removeClass('expanded');
  contentEl.addClass('claudian-hidden');
  headerEl.setAttribute('aria-expanded', 'false');
}

export interface DisclosureButtonOptions {
  /** Runs once, before the body is first shown. */
  onFirstExpand?: () => void;
}

/**
 * Wires a native button to show and hide `body`, which starts hidden.
 * The body's `id`, when set, becomes the button's aria-controls target.
 */
export function setupDisclosureButton(
  button: HTMLButtonElement,
  body: HTMLElement,
  options: DisclosureButtonOptions = {},
): void {
  let onFirstExpand = options.onFirstExpand;
  button.setAttribute('type', 'button');
  button.setAttribute('aria-expanded', 'false');
  if (body.id) button.setAttribute('aria-controls', body.id);
  body.hidden = true;
  button.addEventListener('click', () => {
    if (body.hidden) {
      onFirstExpand?.();
      onFirstExpand = undefined;
    }
    body.hidden = !body.hidden;
    button.setAttribute('aria-expanded', String(!body.hidden));
  });
}
