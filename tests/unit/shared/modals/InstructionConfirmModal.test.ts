import { createMockEl } from '@test/helpers/mockElement';

import {
  InstructionModal,
  type InstructionModalCallbacks,
} from '@/shared/modals/InstructionConfirmModal';

function createMockCallbacks(
  overrides: Partial<InstructionModalCallbacks> = {}
): InstructionModalCallbacks {
  return {
    onAccept: jest.fn(),
    onReject: jest.fn(),
    onClarificationSubmit: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function openModal(
  rawInstruction: string,
  callbacks: InstructionModalCallbacks
): InstructionModal {
  const modal = new InstructionModal({} as any, rawInstruction, callbacks);
  (modal as any).setTitle = jest.fn();
  (modal as any).contentEl = createMockEl();
  (modal as any).close = jest.fn();
  InstructionModal.prototype.onOpen.call(modal);
  return modal;
}

function findByClass(root: any, cls: string): any {
  if (root.hasClass?.(cls)) return root;
  for (const child of root.children || []) {
    const found = findByClass(child, cls);
    if (found) return found;
  }
  return null;
}

function findAllByClass(root: any, cls: string): any[] {
  const results: any[] = [];
  const collect = (el: any) => {
    if (el.hasClass?.(cls)) results.push(el);
    for (const child of el.children || []) collect(child);
  };
  collect(root);
  return results;
}

function clickButton(root: any, text: string): void {
  const buttons = findAllByClass(root, 'claudian-instruction-btn');
  const btn = buttons.find((b: any) => b.textContent === text);
  if (!btn) throw new Error(`Button "${text}" not found`);
  btn.click();
}

describe('InstructionModal', () => {
  describe('onOpen', () => {
    it('renders the raw instruction text', () => {
      const callbacks = createMockCallbacks();
      const modal = openModal('Make it better', callbacks);
      const contentEl = (modal as any).contentEl;

      const originalEl = findByClass(contentEl, 'claudian-instruction-original');
      expect(originalEl).not.toBeNull();
      expect(originalEl.textContent).toBe('Make it better');
    });

    it('starts in loading state', () => {
      const callbacks = createMockCallbacks();
      const modal = openModal('test', callbacks);
      const contentEl = (modal as any).contentEl;

      const loadingEl = findByClass(contentEl, 'claudian-instruction-loading');
      expect(loadingEl).not.toBeNull();
      expect(loadingEl.hasClass('claudian-hidden')).toBe(false);

      const clarificationEl = findByClass(contentEl, 'claudian-instruction-clarification-section');
      expect(clarificationEl.hasClass('claudian-hidden')).toBe(true);

      const confirmationEl = findByClass(contentEl, 'claudian-instruction-confirmation-section');
      expect(confirmationEl.hasClass('claudian-hidden')).toBe(true);
    });

    it('renders Cancel button in loading state', () => {
      const callbacks = createMockCallbacks();
      const modal = openModal('test', callbacks);
      const contentEl = (modal as any).contentEl;

      const buttons = findAllByClass(contentEl, 'claudian-instruction-btn');
      expect(buttons.length).toBe(1);
      expect(buttons[0].textContent).toBe('Cancel');
    });
  });

  describe('showClarification', () => {
    it('transitions to clarification state', () => {
      const callbacks = createMockCallbacks();
      const modal = openModal('test', callbacks);
      const contentEl = (modal as any).contentEl;

      modal.showClarification('What style do you want?');

      const loadingEl = findByClass(contentEl, 'claudian-instruction-loading');
      expect(loadingEl.hasClass('claudian-hidden')).toBe(true);

      const clarificationEl = findByClass(contentEl, 'claudian-instruction-clarification-section');
      expect(clarificationEl.hasClass('claudian-hidden')).toBe(false);
    });

    it('displays the clarification text', () => {
      const callbacks = createMockCallbacks();
      const modal = openModal('test', callbacks);
      const contentEl = (modal as any).contentEl;

      modal.showClarification('What format?');

      const clarificationTextEl = findByClass(contentEl, 'claudian-instruction-clarification');
      expect(clarificationTextEl.textContent).toBe('What format?');
    });

    it('renders Cancel and Submit buttons', () => {
      const callbacks = createMockCallbacks();
      const modal = openModal('test', callbacks);
      const contentEl = (modal as any).contentEl;

      modal.showClarification('Question?');

      const buttons = findAllByClass(contentEl, 'claudian-instruction-btn');
      const buttonTexts = buttons.map((b: any) => b.textContent);
      expect(buttonTexts).toContain('Cancel');
      expect(buttonTexts).toContain('Submit');
    });
  });

  describe('showConfirmation', () => {
    it('transitions to confirmation state', () => {
      const callbacks = createMockCallbacks();
      const modal = openModal('test', callbacks);
      const contentEl = (modal as any).contentEl;

      modal.showConfirmation('Refined instruction text');

      const loadingEl = findByClass(contentEl, 'claudian-instruction-loading');
      expect(loadingEl.hasClass('claudian-hidden')).toBe(true);

      const confirmationEl = findByClass(contentEl, 'claudian-instruction-confirmation-section');
      expect(confirmationEl.hasClass('claudian-hidden')).toBe(false);
    });

    it('displays the refined instruction', () => {
      const callbacks = createMockCallbacks();
      const modal = openModal('test', callbacks);
      const contentEl = (modal as any).contentEl;

      modal.showConfirmation('The refined snippet');

      const refinedEl = findByClass(contentEl, 'claudian-instruction-refined');
      expect(refinedEl.textContent).toBe('The refined snippet');
    });

    it('renders Cancel, Edit, and Accept buttons', () => {
      const callbacks = createMockCallbacks();
      const modal = openModal('test', callbacks);
      const contentEl = (modal as any).contentEl;

      modal.showConfirmation('instruction');

      const buttons = findAllByClass(contentEl, 'claudian-instruction-btn');
      const buttonTexts = buttons.map((b: any) => b.textContent);
      expect(buttonTexts).toContain('Cancel');
      expect(buttonTexts).toContain('Edit');
      expect(buttonTexts).toContain('Accept');
    });
  });

  describe('accept callback', () => {
    it('calls onAccept with the refined instruction', () => {
      const callbacks = createMockCallbacks();
      const modal = openModal('raw', callbacks);
      const contentEl = (modal as any).contentEl;

      modal.showConfirmation('refined text');
      clickButton(contentEl, 'Accept');

      expect(callbacks.onAccept).toHaveBeenCalledWith('refined text');
    });

    it('calls close when accepted', () => {
      const callbacks = createMockCallbacks();
      const modal = openModal('raw', callbacks);
      const contentEl = (modal as any).contentEl;

      modal.showConfirmation('refined');
      clickButton(contentEl, 'Accept');

      expect((modal as any).close).toHaveBeenCalled();
    });

    it('prevents double-accept', () => {
      const callbacks = createMockCallbacks();
      const modal = openModal('raw', callbacks);
      const contentEl = (modal as any).contentEl;

      modal.showConfirmation('refined');
      clickButton(contentEl, 'Accept');
      // Simulate second click - re-render buttons and try again
      modal.showConfirmation('refined');
      clickButton(contentEl, 'Accept');

      expect(callbacks.onAccept).toHaveBeenCalledTimes(1);
    });
  });

  describe('reject callback', () => {
    it('calls onReject when Cancel is clicked', () => {
      const callbacks = createMockCallbacks();
      const modal = openModal('test', callbacks);
      const contentEl = (modal as any).contentEl;

      clickButton(contentEl, 'Cancel');

      expect(callbacks.onReject).toHaveBeenCalled();
    });

    it('calls close when rejected', () => {
      const callbacks = createMockCallbacks();
      const modal = openModal('test', callbacks);
      const contentEl = (modal as any).contentEl;

      clickButton(contentEl, 'Cancel');

      expect((modal as any).close).toHaveBeenCalled();
    });

    it('prevents double-reject', () => {
      const callbacks = createMockCallbacks();
      const modal = openModal('test', callbacks);
      const contentEl = (modal as any).contentEl;

      clickButton(contentEl, 'Cancel');
      // Reset buttons and try again
      modal.showClarification('q');
      clickButton(contentEl, 'Cancel');

      expect(callbacks.onReject).toHaveBeenCalledTimes(1);
    });
  });

  describe('onClose', () => {
    it('calls onReject if not already resolved', () => {
      const callbacks = createMockCallbacks();
      const modal = openModal('test', callbacks);

      InstructionModal.prototype.onClose.call(modal);

      expect(callbacks.onReject).toHaveBeenCalled();
    });

    it('does not call onReject if already resolved', () => {
      const callbacks = createMockCallbacks();
      const modal = openModal('test', callbacks);
      const contentEl = (modal as any).contentEl;

      modal.showConfirmation('refined');
      clickButton(contentEl, 'Accept');

      InstructionModal.prototype.onClose.call(modal);

      expect(callbacks.onReject).not.toHaveBeenCalled();
    });
  });

  describe('showError', () => {
    it('closes the modal and marks as resolved', () => {
      const callbacks = createMockCallbacks();
      const modal = openModal('test', callbacks);

      modal.showError('Something went wrong');

      expect((modal as any).close).toHaveBeenCalled();

      // onClose should not call onReject since resolved=true
      InstructionModal.prototype.onClose.call(modal);
      expect(callbacks.onReject).not.toHaveBeenCalled();
    });
  });

  describe('showClarificationLoading', () => {
    it('transitions back to loading state', () => {
      const callbacks = createMockCallbacks();
      const modal = openModal('test', callbacks);
      const contentEl = (modal as any).contentEl;

      modal.showClarification('question?');
      modal.showClarificationLoading();

      const loadingEl = findByClass(contentEl, 'claudian-instruction-loading');
      expect(loadingEl.hasClass('claudian-hidden')).toBe(false);

      const clarificationEl = findByClass(contentEl, 'claudian-instruction-clarification-section');
      expect(clarificationEl.hasClass('claudian-hidden')).toBe(true);
    });
  });
});
