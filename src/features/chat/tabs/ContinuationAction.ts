import type { ChatState } from '../state/ChatState';

export const CONTINUATION_CONTEXT_TOKEN_THRESHOLD = 200_000;
export const CONTINUATION_TOOL_CALL_THRESHOLD = 80;

export function shouldRecommendContinuation(state: ChatState): boolean {
  const contextTokens = state.usage?.contextTokens ?? 0;
  const toolCalls = countToolCalls(state.messages);
  return contextTokens >= CONTINUATION_CONTEXT_TOKEN_THRESHOLD || toolCalls >= CONTINUATION_TOOL_CALL_THRESHOLD;
}

type CountableToolCall = { id?: string; subagent?: { toolCalls: readonly CountableToolCall[] } };

export function countToolCalls(messages: readonly { toolCalls?: readonly CountableToolCall[] }[]): number {
  const seen = new Set<CountableToolCall>();
  const count = (toolCall: CountableToolCall): number => {
    if (seen.has(toolCall)) return 0;
    seen.add(toolCall);
    return 1 + (toolCall.subagent?.toolCalls.reduce((total, nested) => total + count(nested), 0) ?? 0);
  };
  return messages.reduce((total, message) => total + (message.toolCalls?.reduce(
    (counted, toolCall) => counted + count(toolCall), 0,
  ) ?? 0), 0);
}

export interface ContinuationAction {
  readonly buttonEl: HTMLButtonElement;
  refresh(): void;
}

export function createContinuationAction(
  parentEl: HTMLElement,
  state: ChatState,
  onContinue: () => void | Promise<void>,
  isPending: () => boolean = () => false,
): ContinuationAction {
  const button = parentEl.createEl('button', {
    cls: 'claudian-continue-new-tab-button',
    text: 'Continue in new tab',
  });
  button.type = 'button';
  button.setAttribute('aria-label', 'Continue in a new tab with a compact handoff');
  button.setAttribute('data-tooltip', 'Continue in new tab. Creates a local compact handoff and sends it automatically.');
  button.setAttribute('aria-description', 'The current tab stays unchanged.');
  const refresh = (): void => {
    const pending = isPending();
    const recommended = shouldRecommendContinuation(state) && !pending;
    button.toggleClass('mod-cta', recommended);
    button.disabled = pending;
    button.setAttribute('aria-busy', String(pending));
    button.setAttribute('data-recommended', String(recommended));
    button.setAttribute('aria-label', pending
      ? 'Continuation in new tab is queued'
      : `${recommended ? 'Recommended: ' : ''}Continue in a new tab with a compact handoff`);
  };
  refresh();
  button.addEventListener('click', () => { void Promise.resolve(onContinue()).finally(refresh); });
  return { buttonEl: button, refresh };
}
