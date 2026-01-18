/**
 * Claudian - Thinking block renderer
 *
 * Renders extended thinking blocks with live timer and expand/collapse.
 */

import { collapseElement, setupCollapsible } from './collapsible';

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
  isExpanded: boolean;
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

  // Create state object first so toggle can reference it
  const state: ThinkingBlockState = {
    wrapperEl,
    contentEl,
    labelEl,
    content: '',
    startTime,
    timerInterval,
    isExpanded: false,
  };

  // Setup collapsible behavior (handles click, keyboard, ARIA, CSS)
  setupCollapsible(wrapperEl, header, contentEl, state);

  return state;
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

  // Collapse when done and sync state
  const header = state.wrapperEl.querySelector('.claudian-thinking-header');
  if (header) {
    collapseElement(state.wrapperEl, header as HTMLElement, state.contentEl, state);
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
  header.setAttribute('aria-label', 'Extended thinking - click to expand');

  // Label with duration
  const labelEl = header.createSpan({ cls: 'claudian-thinking-label' });
  const labelText = durationSeconds !== undefined ? `Thought for ${durationSeconds}s` : 'Thought';
  labelEl.setText(labelText);

  // Collapsible content
  const contentEl = wrapperEl.createDiv({ cls: 'claudian-thinking-content' });
  renderContent(contentEl, content);

  // Setup collapsible behavior (handles click, keyboard, ARIA, CSS)
  const state = { isExpanded: false };
  setupCollapsible(wrapperEl, header, contentEl, state);

  return wrapperEl;
}
