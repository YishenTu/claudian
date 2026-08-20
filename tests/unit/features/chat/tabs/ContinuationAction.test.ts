import { createMockEl } from '@test/helpers/MockElement';

import { ChatState } from '@/features/chat/state/ChatState';
import {
  countToolCalls,
  createContinuationAction,
  shouldRecommendContinuation,
} from '@/features/chat/tabs/ContinuationAction';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolver => { resolve = resolver; });
  return { promise, resolve };
}

describe('ContinuationAction', () => {
  it('recommends at the context and recursive tool thresholds without looping cycles', () => {
    const nested: any = { id: 'nested' };
    const parent: any = { id: 'parent', subagent: { toolCalls: [nested] } };
    nested.subagent = { toolCalls: [parent] };
    expect(countToolCalls([{ toolCalls: [parent] }])).toBe(2);
    const state = new ChatState();
    state.usage = { inputTokens: 0, contextTokens: 200_000, contextWindow: 200_000, percentage: 100 };
    expect(shouldRecommendContinuation(state)).toBe(true);
  });

  it('renders the recommendation class and restores enabled aria state after deferred completion', async () => {
    const parent = createMockEl();
    const state = new ChatState();
    state.usage = { inputTokens: 0, contextTokens: 200_000, contextWindow: 200_000, percentage: 100 };
    const completion = deferred<void>();
    let pending = false;
    let refresh = (): void => undefined;
    const action = createContinuationAction(
      parent as any,
      state,
      async () => {
        pending = true;
        refresh();
        await completion.promise;
        pending = false;
      },
      () => pending,
    );
    refresh = action.refresh;

    expect((action.buttonEl as any).hasClass('claudian-continue-new-tab-button')).toBe(true);
    expect((action.buttonEl as any).hasClass('mod-cta')).toBe(true);
    expect(action.buttonEl.getAttribute('data-recommended')).toBe('true');
    expect(action.buttonEl.getAttribute('aria-label')).toContain('Recommended:');

    (action.buttonEl as any).click();
    expect(action.buttonEl.disabled).toBe(true);
    expect(action.buttonEl.getAttribute('aria-busy')).toBe('true');
    expect(action.buttonEl.getAttribute('data-recommended')).toBe('false');
    expect((action.buttonEl as any).hasClass('mod-cta')).toBe(false);

    completion.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(action.buttonEl.disabled).toBe(false);
    expect(action.buttonEl.getAttribute('aria-busy')).toBe('false');
    expect((action.buttonEl as any).hasClass('mod-cta')).toBe(true);
  });
});
