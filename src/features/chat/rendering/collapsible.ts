export interface CollapsibleState {
  isExpanded: boolean;
}

export interface CollapsibleOptions {
  /** Initial expanded state (default: false) */
  initiallyExpanded?: boolean;
  /** Callback when state changes */
  onToggle?: (isExpanded: boolean) => void;
  /** Base label for aria-label (will append "click to expand/collapse") */
  baseAriaLabel?: string;
}

/**
 * Setup collapsible behavior on a header/content pair.
 *
 * Handles:
 * - Click to toggle
 * - Enter/Space keyboard navigation
 * - aria-expanded attribute
 * - CSS 'expanded' class on wrapper
 * - content display style
 *
 * @param wrapperEl - The wrapper element to add/remove 'expanded' class
 * @param headerEl - The clickable header element
 * @param contentEl - The content element to show/hide
 * @param state - State object to track isExpanded (mutated by this function)
 * @param options - Optional configuration
 */
export function setupCollapsible(
  wrapperEl: HTMLElement,
  headerEl: HTMLElement,
  contentEl: HTMLElement,
  state: CollapsibleState,
  options: CollapsibleOptions = {}
): void {
  const { initiallyExpanded = false, onToggle, baseAriaLabel } = options;

  // Helper to update aria-label based on expanded state
  const updateAriaLabel = (isExpanded: boolean) => {
    if (baseAriaLabel) {
      const action = isExpanded ? 'click to collapse' : 'click to expand';
      headerEl.setAttribute('aria-label', `${baseAriaLabel} - ${action}`);
    }
  };

  // Set initial state
  state.isExpanded = initiallyExpanded;
  if (initiallyExpanded) {
    wrapperEl.addClass('expanded');
    contentEl.style.display = 'block';
    headerEl.setAttribute('aria-expanded', 'true');
  } else {
    contentEl.style.display = 'none';
    headerEl.setAttribute('aria-expanded', 'false');
  }
  updateAriaLabel(initiallyExpanded);

  // Toggle handler
  const toggleExpand = () => {
    state.isExpanded = !state.isExpanded;
    if (state.isExpanded) {
      wrapperEl.addClass('expanded');
      contentEl.style.display = 'block';
      headerEl.setAttribute('aria-expanded', 'true');
    } else {
      wrapperEl.removeClass('expanded');
      contentEl.style.display = 'none';
      headerEl.setAttribute('aria-expanded', 'false');
    }
    updateAriaLabel(state.isExpanded);
    onToggle?.(state.isExpanded);
  };

  // Click handler
  headerEl.addEventListener('click', toggleExpand);

  // Keyboard handler (Enter/Space)
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
  contentEl.style.display = 'none';
  headerEl.setAttribute('aria-expanded', 'false');
}
