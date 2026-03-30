import { createMockEl } from '@test/helpers/mockElement';

import {
  type CodexPlanDecision,
  InlineCodexPlanApproval,
} from '@/features/chat/rendering/InlineCodexPlanApproval';

beforeAll(() => {
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  };
});

function createApproval(): {
  approval: InlineCodexPlanApproval;
  resolve: jest.Mock<void, [CodexPlanDecision | null]>;
  container: ReturnType<typeof createMockEl>;
  fireKey: (key: string) => void;
} {
  const container = createMockEl();
  const resolve = jest.fn<void, [CodexPlanDecision | null]>();
  const approval = new InlineCodexPlanApproval(container as any, resolve);
  approval.render();

  // The component binds keydown to rootEl via addEventListener.
  // Our mock's dispatchEvent forwards {type, key} objects to listeners.
  const fireKey = (key: string) => {
    const rootEl = (approval as any).rootEl;
    rootEl.dispatchEvent({
      type: 'keydown',
      key,
      preventDefault: () => {},
      stopPropagation: () => {},
    });
  };

  return { approval, resolve, container, fireKey };
}

describe('InlineCodexPlanApproval', () => {
  describe('decisions', () => {
    it('resolves with implement when Enter on first item (default focus)', () => {
      const { resolve, fireKey } = createApproval();
      fireKey('Enter');
      expect(resolve).toHaveBeenCalledWith({ type: 'implement' });
    });

    it('resolves with cancel when Cancel is selected', () => {
      const { approval, resolve, fireKey } = createApproval();
      fireKey('ArrowDown'); // -> Revise (auto-focuses input)
      // Esc out of input focus to navigate further
      (approval as any).isInputFocused = false;
      fireKey('ArrowDown'); // -> Cancel
      fireKey('Enter');
      expect(resolve).toHaveBeenCalledWith({ type: 'cancel' });
    });

    it('resolves with revise containing text when feedback is submitted', () => {
      const { approval, resolve, fireKey } = createApproval();
      fireKey('ArrowDown'); // -> Revise
      fireKey('Enter');     // focuses input

      // Simulate typing: set feedbackInput value and submit
      const feedbackInput = (approval as any).feedbackInput;
      feedbackInput.value = 'Add error handling';
      // The input is now "focused" — simulate Enter in input-focused mode
      (approval as any).isInputFocused = true;
      fireKey('Enter');

      expect(resolve).toHaveBeenCalledWith({ type: 'revise', text: 'Add error handling' });
    });
  });

  describe('keyboard navigation', () => {
    it('moves focus down with ArrowDown', () => {
      const { approval, fireKey } = createApproval();
      fireKey('ArrowDown');
      expect((approval as any).focusedIndex).toBe(1);
    });

    it('moves focus up with ArrowUp', () => {
      const { approval, fireKey } = createApproval();
      fireKey('ArrowDown'); // -> Revise (auto-focuses input)
      (approval as any).isInputFocused = false;
      fireKey('ArrowUp');
      expect((approval as any).focusedIndex).toBe(0);
    });

    it('does not go below last item', () => {
      const { approval, fireKey } = createApproval();
      fireKey('ArrowDown'); // -> Revise (auto-focuses input)
      (approval as any).isInputFocused = false;
      fireKey('ArrowDown'); // -> Cancel
      fireKey('ArrowDown'); // clamp at Cancel
      expect((approval as any).focusedIndex).toBe(2);
    });

    it('does not go above first item', () => {
      const { approval, fireKey } = createApproval();
      fireKey('ArrowUp');
      expect((approval as any).focusedIndex).toBe(0);
    });
  });

  describe('Esc and destroy', () => {
    it('resolves with null on Esc', () => {
      const { resolve, fireKey } = createApproval();
      fireKey('Escape');
      expect(resolve).toHaveBeenCalledWith(null);
    });

    it('resolves with null on destroy()', () => {
      const { approval, resolve } = createApproval();
      approval.destroy();
      expect(resolve).toHaveBeenCalledWith(null);
    });

    it('does not resolve twice on double destroy', () => {
      const { approval, resolve } = createApproval();
      approval.destroy();
      approval.destroy();
      expect(resolve).toHaveBeenCalledTimes(1);
    });
  });
});
