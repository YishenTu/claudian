/**
 * Claudian - Thinking block renderer
 *
 * Renders extended thinking blocks with live timer and expand/collapse.
 */

/** Callback for rendering markdown content. */
export type RenderContentFn = (el: HTMLElement, markdown: string) => Promise<void>;

/** State for a streaming thinking block. */
export interface ThinkingBlockState {
  wrapperEl: HTMLElement;
  contentEl: HTMLElement;
  labelEl: HTMLElement;
  content: string;
  startTime: number;
  timerInterval: ReturnType<typeof setInterval> | null;
}

/** Create a streaming thinking block. Collapsed by default. */
export function createThinkingBlock(
  parentEl: HTMLElement,
  renderContent: RenderContentFn
): ThinkingBlockState {
  const wrapperEl = parentEl.createDiv({ cls: 'claudian-thinking-block' });

  // Header (clickable to expand/collapse)
  const header = wrapperEl.createDiv({ cls: 'claudian-thinking-header' });
  header.setAttribute('tabindex', '0');
  header.setAttribute('role', 'button');
  header.setAttribute('aria-expanded', 'false');
  header.setAttribute('aria-label', 'Extended thinking - click to expand');

  // Label with timer
  const labelEl = header.createSpan({ cls: 'claudian-thinking-label' });
  const startTime = Date.now();
  labelEl.setText('Thinking 0s...');

  // Start timer interval to update label every second
  const timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    labelEl.setText(`Thinking ${elapsed}s...`);
  }, 1000);

  // Collapsible content (collapsed by default)
  const contentEl = wrapperEl.createDiv({ cls: 'claudian-thinking-content' });
  contentEl.style.display = 'none';

  // Toggle expand/collapse handler
  let isExpanded = false;
  const toggleExpand = () => {
    isExpanded = !isExpanded;
    if (isExpanded) {
      contentEl.style.display = 'block';
      wrapperEl.addClass('expanded');
      header.setAttribute('aria-expanded', 'true');
    } else {
      contentEl.style.display = 'none';
      wrapperEl.removeClass('expanded');
      header.setAttribute('aria-expanded', 'false');
    }
  };

  // Click handler
  header.addEventListener('click', toggleExpand);

  // Keyboard handler (Enter/Space)
  header.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleExpand();
    }
  });

  return {
    wrapperEl,
    contentEl,
    labelEl,
    content: '',
    startTime,
    timerInterval,
  };
}

/** Append content to a streaming thinking block. */
export async function appendThinkingContent(
  state: ThinkingBlockState,
  content: string,
  renderContent: RenderContentFn
) {
  state.content += content;
  await renderContent(state.contentEl, state.content);
}

/** Finalize a thinking block (stop timer, update label, collapse). */
export function finalizeThinkingBlock(state: ThinkingBlockState): number {
  // Stop the timer
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }

  // Calculate final duration
  const durationSeconds = Math.floor((Date.now() - state.startTime) / 1000);

  // Update label to show final duration (without "...")
  state.labelEl.setText(`Thought for ${durationSeconds}s`);

  // Collapse when done
  state.contentEl.style.display = 'none';
  state.wrapperEl.removeClass('expanded');
  const header = state.wrapperEl.querySelector('.claudian-thinking-header');
  if (header) {
    header.setAttribute('aria-expanded', 'false');
  }

  return durationSeconds;
}

/** Clean up a thinking block state (call on view close). */
export function cleanupThinkingBlock(state: ThinkingBlockState | null) {
  if (state?.timerInterval) {
    clearInterval(state.timerInterval);
  }
}

/** Render a stored thinking block (non-streaming, collapsed by default). */
export function renderStoredThinkingBlock(
  parentEl: HTMLElement,
  content: string,
  durationSeconds: number | undefined,
  renderContent: RenderContentFn
): HTMLElement {
  const wrapperEl = parentEl.createDiv({ cls: 'claudian-thinking-block' });

  // Header (clickable to expand/collapse)
  const header = wrapperEl.createDiv({ cls: 'claudian-thinking-header' });
  header.setAttribute('tabindex', '0');
  header.setAttribute('role', 'button');
  header.setAttribute('aria-expanded', 'false');
  header.setAttribute('aria-label', 'Extended thinking - click to expand');

  // Label with duration
  const labelEl = header.createSpan({ cls: 'claudian-thinking-label' });
  const labelText = durationSeconds !== undefined ? `Thought for ${durationSeconds}s` : 'Thinking';
  labelEl.setText(labelText);

  // Collapsible content (starts collapsed)
  const contentEl = wrapperEl.createDiv({ cls: 'claudian-thinking-content' });
  contentEl.style.display = 'none';
  renderContent(contentEl, content);

  // Toggle expand/collapse handler
  let isExpanded = false;
  const toggleExpand = () => {
    isExpanded = !isExpanded;
    if (isExpanded) {
      contentEl.style.display = 'block';
      wrapperEl.addClass('expanded');
      header.setAttribute('aria-expanded', 'true');
    } else {
      contentEl.style.display = 'none';
      wrapperEl.removeClass('expanded');
      header.setAttribute('aria-expanded', 'false');
    }
  };

  // Click handler
  header.addEventListener('click', toggleExpand);

  // Keyboard handler (Enter/Space)
  header.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleExpand();
    }
  });

  return wrapperEl;
}
