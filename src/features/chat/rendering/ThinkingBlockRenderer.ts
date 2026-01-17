/**
 * Claudian - Thinking block renderer
 *
 * Renders extended thinking blocks with live timer and expand/collapse.
 * Also renders the merged flavor text + thinking indicator.
 */

import { FLAVOR_TEXTS } from '../constants';
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
  const labelText = durationSeconds !== undefined ? `Thought for ${durationSeconds}s` : 'Thinking';
  labelEl.setText(labelText);

  // Collapsible content
  const contentEl = wrapperEl.createDiv({ cls: 'claudian-thinking-content' });
  renderContent(contentEl, content);

  // Setup collapsible behavior (handles click, keyboard, ARIA, CSS)
  const state = { isExpanded: false };
  setupCollapsible(wrapperEl, header, contentEl, state);

  return wrapperEl;
}

// ============================================
// Merged Flavor Text + Thinking Indicator
// ============================================

/** State for merged flavor text + thinking indicator. */
export interface FlavorThinkingState {
  wrapperEl: HTMLElement;
  flavorEl: HTMLElement;
  hintEl: HTMLElement;
  contentEl: HTMLElement;
  timerEl: HTMLElement;

  flavorText: string;
  thinkingContent: string;
  hasThinkingContent: boolean;

  startTime: number | null;
  timerInterval: ReturnType<typeof setInterval> | null;
  isExpanded: boolean;
  isFinalized: boolean;
}

/** Create a merged flavor text + thinking indicator. */
export function createFlavorThinkingBlock(parentEl: HTMLElement): FlavorThinkingState {
  const wrapperEl = parentEl.createDiv({ cls: 'claudian-flavor-thinking' });

  // Header line: flavor text + hint (always visible)
  const headerEl = wrapperEl.createDiv({ cls: 'claudian-flavor-thinking-header' });
  const flavorEl = headerEl.createSpan({ cls: 'claudian-flavor-text' });
  const hintEl = headerEl.createSpan({ cls: 'claudian-thinking-hint' });

  // Set random flavor text
  const flavorText = FLAVOR_TEXTS[Math.floor(Math.random() * FLAVOR_TEXTS.length)];
  flavorEl.setText(flavorText);
  hintEl.setText(' (esc to interrupt)');

  // Collapsible content container (hidden by default)
  const contentEl = wrapperEl.createDiv({ cls: 'claudian-flavor-thinking-content' });
  contentEl.style.display = 'none';

  // Timer inside expanded content
  const timerEl = contentEl.createDiv({ cls: 'claudian-flavor-thinking-timer' });

  return {
    wrapperEl,
    flavorEl,
    hintEl,
    contentEl,
    timerEl,
    flavorText,
    thinkingContent: '',
    hasThinkingContent: false,
    startTime: null,
    timerInterval: null,
    isExpanded: false,
    isFinalized: false,
  };
}

/** Append thinking content to the merged block. Enables expand/collapse on first content. */
export async function appendFlavorThinkingContent(
  state: FlavorThinkingState,
  content: string,
  renderContent: RenderContentFn
): Promise<void> {
  // First thinking chunk - initialize
  if (!state.hasThinkingContent) {
    state.hasThinkingContent = true;
    state.startTime = Date.now();

    // Update hint to show "· thinking"
    state.hintEl.setText(' (esc to interrupt · thinking)');

    // Make header clickable
    state.wrapperEl.addClass('claudian-has-thinking');
    setupFlavorThinkingCollapsible(state);

    // Start timer
    state.timerEl.setText('Thinking 0s...');
    state.timerInterval = setInterval(() => {
      // Stop timer if DOM element is no longer connected
      if (!state.timerEl?.isConnected) {
        if (state.timerInterval) {
          clearInterval(state.timerInterval);
          state.timerInterval = null;
        }
        return;
      }
      if (state.startTime && !state.isFinalized) {
        const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
        state.timerEl.setText(`Thinking ${elapsed}s...`);
      }
    }, 1000);
  }

  // Accumulate content
  state.thinkingContent += content;

  // Render content
  let thinkingTextEl = state.contentEl.querySelector('.claudian-thinking-text') as HTMLElement;
  if (!thinkingTextEl) {
    thinkingTextEl = state.contentEl.createDiv({ cls: 'claudian-thinking-text' });
  }
  try {
    await renderContent(thinkingTextEl, state.thinkingContent);
  } catch {
    // Silently ignore render errors during streaming (DOM may be detached)
  }
}

/** Setup click-to-expand behavior for flavor thinking block. */
function setupFlavorThinkingCollapsible(state: FlavorThinkingState): void {
  const headerEl = state.wrapperEl.querySelector('.claudian-flavor-thinking-header') as HTMLElement;
  if (!headerEl) return;

  const toggleExpand = () => {
    if (!state.hasThinkingContent) return;

    state.isExpanded = !state.isExpanded;
    if (state.isExpanded) {
      state.wrapperEl.addClass('expanded');
      state.contentEl.style.display = 'block';
      headerEl.setAttribute('aria-expanded', 'true');
    } else {
      state.wrapperEl.removeClass('expanded');
      state.contentEl.style.display = 'none';
      headerEl.setAttribute('aria-expanded', 'false');
    }
  };

  headerEl.addEventListener('click', toggleExpand);
  headerEl.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleExpand();
    }
  });

  headerEl.setAttribute('tabindex', '0');
  headerEl.setAttribute('role', 'button');
  headerEl.setAttribute('aria-expanded', 'false');
  headerEl.setAttribute('aria-label', 'Thinking - click to expand');
}

/** Finalize thinking (stop timer, update labels). Returns duration in seconds. */
export function finalizeFlavorThinking(state: FlavorThinkingState): number {
  // Stop timer
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }

  // Calculate duration
  const duration = state.startTime ? Math.floor((Date.now() - state.startTime) / 1000) : 0;
  state.isFinalized = true;

  // Update timer label to final text
  state.timerEl.setText(`Thought for ${duration}s`);

  // Remove ", thinking" from hint
  state.hintEl.setText(' (esc to interrupt)');

  // Collapse
  if (state.isExpanded) {
    state.isExpanded = false;
    state.wrapperEl.removeClass('expanded');
    state.contentEl.style.display = 'none';
    const headerEl = state.wrapperEl.querySelector('.claudian-flavor-thinking-header');
    if (headerEl) {
      headerEl.setAttribute('aria-expanded', 'false');
    }
  }

  return duration;
}

/** Remove and clean up the flavor thinking block. */
export function hideFlavorThinking(state: FlavorThinkingState | null): void {
  if (!state) return;

  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }

  state.wrapperEl.remove();
}
