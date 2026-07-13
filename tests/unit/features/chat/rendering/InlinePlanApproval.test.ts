import { createMockEl } from '@test/helpers/mockElement';

import {
  InlinePlanApproval,
  type PlanApprovalDecision,
} from '@/features/chat/rendering/InlinePlanApproval';

beforeAll(() => {
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  };
});

function createApproval(): {
  approval: InlinePlanApproval;
  resolve: jest.Mock<void, [PlanApprovalDecision | null]>;
  container: ReturnType<typeof createMockEl>;
  fireKey: (key: string, isComposing?: boolean) => void;
} {
  const container = createMockEl();
  const resolve = jest.fn<void, [PlanApprovalDecision | null]>();
  const approval = new InlinePlanApproval(container as any, resolve);
  approval.render();

  // The component binds keydown to rootEl via addEventListener.
  // Our mock's dispatchEvent forwards keyboard event objects to listeners.
  const fireKey = (key: string, isComposing = false) => {
    const rootEl = (approval as any).rootEl;
    rootEl.dispatchEvent({
      type: 'keydown',
      key,
      isComposing,
      preventDefault: () => {},
      stopPropagation: () => {},
    });
  };

  return { approval, resolve, container, fireKey };
}

describe('InlinePlanApproval', () => {
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

    it('does not submit feedback on Enter during IME composition', () => {
      const { approval, resolve, fireKey } = createApproval();
      const feedbackInput = (approval as any).feedbackInput;
      feedbackInput.value = 'composing text';
      feedbackInput.dispatchEvent('focus');

      fireKey('Enter', true);

      expect(resolve).not.toHaveBeenCalled();
      expect((approval as any).isInputFocused).toBe(true);
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
