import { collapseElement, setupCollapsible } from '@/features/chat/rendering/collapsible';
import { t } from '@/i18n/i18n';

export type RenderContentFn = (el: HTMLElement, markdown: string) => Promise<void>;

export interface ThinkingBlockState {
  wrapperEl: HTMLElement;
  contentEl: HTMLElement;
  labelEl: HTMLElement;
  timerInterval: number | null;
  isExpanded: boolean;
}

export interface ThinkingBlockOptions {
  startTime: number;
  onToggle?: (isExpanded: boolean) => void;
}

interface ThinkingBlockElements {
  wrapperEl: HTMLElement;
  headerEl: HTMLElement;
  labelEl: HTMLElement;
  contentEl: HTMLElement;
}

function createThinkingBlockElements(parentEl: HTMLElement, label: string, content = ''): ThinkingBlockElements {
  const wrapperEl = parentEl.createDiv({ cls: 'claudian-thinking-block' });
  const headerEl = wrapperEl.createDiv({ cls: 'claudian-thinking-header' });
  const labelEl = headerEl.createSpan({ cls: 'claudian-thinking-label' });
  labelEl.setText(label);
  const contentEl = wrapperEl.createDiv({ cls: 'claudian-thinking-content', text: content });
  return { wrapperEl, headerEl, labelEl, contentEl };
}

export function createThinkingBlock(
  parentEl: HTMLElement,
  options: ThinkingBlockOptions,
): ThinkingBlockState {
  const { wrapperEl, headerEl, labelEl, contentEl } = createThinkingBlockElements(parentEl, t('chat.thinking.active', { seconds: 0 }));
  const { startTime } = options;

  // Start timer interval to update label every second
  const timerInterval = window.setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    labelEl.setText(t('chat.thinking.active', { seconds: elapsed }));
  }, 1000);

  const state: ThinkingBlockState = {
    wrapperEl,
    contentEl,
    labelEl,
    timerInterval,
    isExpanded: false,
  };

  setupCollapsible(wrapperEl, headerEl, contentEl, state, {
    onToggle: options.onToggle,
  });

  return state;
}

export function finalizeThinkingBlock(state: ThinkingBlockState, durationSeconds: number): void {
  // Stop the timer
  if (state.timerInterval) {
    window.clearInterval(state.timerInterval);
    state.timerInterval = null;
  }

  // Update label to show final duration (without "...")
  state.labelEl.setText(t('chat.thinking.completed', { seconds: durationSeconds }));

  // Collapse when done and sync state
  const header = state.wrapperEl.querySelector('.claudian-thinking-header');
  if (header) {
    collapseElement(state.wrapperEl, header as HTMLElement, state.contentEl, state);
  }
}

export function cleanupThinkingBlock(state: ThinkingBlockState | null) {
  if (state?.timerInterval) {
    window.clearInterval(state.timerInterval);
  }
}

export function renderStoredThinkingBlock(
  parentEl: HTMLElement,
  content: string,
  durationSeconds: number | undefined,
  renderContent: RenderContentFn
): HTMLElement {
  const label = durationSeconds !== undefined ? t('chat.thinking.completed', { seconds: durationSeconds }) : t('chat.thinking.label');
  const { wrapperEl, headerEl, contentEl } = createThinkingBlockElements(parentEl, label, content);
  setupCollapsible(wrapperEl, headerEl, contentEl, { isExpanded: false }, {
    onFirstExpand: () => {
      void renderContent(contentEl, content).catch(() => { contentEl.setText(content); });
    },
  });

  return wrapperEl;
}
