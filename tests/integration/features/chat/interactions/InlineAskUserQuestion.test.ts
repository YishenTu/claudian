/** @vitest-environment jsdom */

import { fireEvent, within } from '@testing-library/dom';
import type { Mock } from 'vitest';

import { type InlineAskQuestionConfig, InlineAskUserQuestion } from '@/features/chat/interactions/InlineAskUserQuestion';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { document.body.replaceChildren(); vi.useRealTimers(); });

function makeInput(
  questions: Array<{
    question: string;
    options: unknown[];
    multiSelect?: boolean;
    header?: string;
    isOther?: boolean;
  }>,
): Record<string, unknown> {
  return { questions };
}

function renderWidget(
  input: Record<string, unknown>,
  signal?: AbortSignal,
): { container: HTMLElement; resolve: Mock; widget: InlineAskUserQuestion } {
  const container = document.body.createDiv();
  const resolve = vi.fn();
  const widget = new InlineAskUserQuestion(container, input, resolve, signal);
  widget.render();
  vi.advanceTimersByTime(20);
  onTestFinished(() => widget.destroy());
  return { container, resolve, widget };
}

function fireKeyDown(root: HTMLElement, key: string, opts: { shiftKey?: boolean; isComposing?: boolean } = {}): void {
  fireEvent.keyDown(root, { key, ...opts });
}

function findRoot(container: HTMLElement): HTMLElement {
  return within(container).getByRole('region');
}

function findItems(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.claudian-ask-item'));
}

describe('InlineAskUserQuestion', () => {
  describe('parseQuestions', () => {
    it('resolves null when input has no questions', () => {
      const { resolve } = renderWidget({});
      expect(resolve).toHaveBeenCalledWith(null);
    });

    it('resolves null when questions is not an array', () => {
      const { resolve } = renderWidget({ questions: 'bad' });
      expect(resolve).toHaveBeenCalledWith(null);
    });

    it('resolves null when questions array is empty', () => {
      const { resolve } = renderWidget({ questions: [] });
      expect(resolve).toHaveBeenCalledWith(null);
    });

    it('shows no native title tooltip on question tabs', () => {
      const { container } = renderWidget(makeInput([
        { question: 'First question?', options: ['A'] },
        { question: 'Second question?', options: ['B'] },
      ]));
      const tabs = Array.from(container.querySelectorAll<HTMLElement>('.claudian-ask-tab')) as HTMLElement[];
      expect(tabs.map(tab => tab.getAttribute('title'))).toEqual([null, null, null]);
    });

    it('filters out questions with no options', () => {
      const input = makeInput([
        { question: 'Q1', options: [] },
        { question: 'Q2', options: ['A'] },
      ]);
      const { container, resolve } = renderWidget(input);
      // Should render — Q2 is valid
      expect(resolve).not.toHaveBeenCalled();
      expect(Array.from(container.querySelectorAll<HTMLElement>('.claudian-ask-tab'))).toHaveLength(2);
      expect(container.querySelector<HTMLElement>('.claudian-ask-question-text')?.textContent).toBe('Q2');
      findItems(container)[0]?.click();
      findItems(container)[0]?.click();
      expect(resolve).toHaveBeenCalledWith({ Q2: 'A' });
    });

    it('resolves null when all questions have empty options', () => {
      const input = makeInput([
        { question: 'Q1', options: [] },
        { question: 'Q2', options: [] },
      ]);
      const { resolve } = renderWidget(input);
      expect(resolve).toHaveBeenCalledWith(null);
    });

    it('keeps questions that only allow free-form input', () => {
      const input = {
        questions: [
          {
            id: 'secret_q',
            question: 'Enter token',
            header: 'Token',
            options: null,
            isOther: true,
            isSecret: true,
          },
        ],
      };
      const { container, resolve } = renderWidget(input);

      expect(resolve).not.toHaveBeenCalled();
      expect(container.querySelector<HTMLElement>('.claudian-ask-custom-item')).not.toBeNull();
    });

    it('filters out entries missing required fields', () => {
      const input = {
        questions: [
          { question: 'Valid', options: ['A'] },
          { options: ['B'] }, // missing question
          'not an object',
          null,
        ],
      };
      const { container, resolve } = renderWidget(input);
      // Only "Valid" survives — widget should render
      expect(resolve).not.toHaveBeenCalled();
      expect(Array.from(container.querySelectorAll<HTMLElement>('.claudian-ask-tab'))).toHaveLength(2);
      expect(container.querySelector<HTMLElement>('.claudian-ask-question-text')?.textContent).toBe('Valid');
      findItems(container)[0]?.click();
      findItems(container)[0]?.click();
      expect(resolve).toHaveBeenCalledWith({ Valid: 'A' });
    });

    it('deduplicates options with the same label', () => {
      const input = makeInput([
        { question: 'Pick', options: ['A', 'A', 'B'] },
      ]);
      const { container } = renderWidget(input);
      // Find option items (excluding custom input row)
      const items = Array.from(container.querySelectorAll<HTMLElement>('.claudian-ask-item'));
      // 2 unique options + 1 custom input row = 3
      const optionLabels = items
        .filter((item) => !item.hasClass('claudian-ask-custom-item'))
        .map((item) => {
          const labelEl = item.querySelector<HTMLElement>('.claudian-ask-item-label');
          return labelEl?.textContent;
        });
      expect(optionLabels).toEqual(['A', 'B']);
    });

    it('uses header when provided, falls back to Q index', () => {
      const input = makeInput([
        { question: 'First', options: ['A'], header: 'MyHeader' },
        { question: 'Second', options: ['B'] },
      ]);
      const { container } = renderWidget(input);
      const tabLabels = Array.from(container.querySelectorAll<HTMLElement>('.claudian-ask-tab-label'));
      // Tab labels: MyHeader, Q2, Submit
      expect(tabLabels[0]?.textContent).toBe('MyHeader');
      expect(tabLabels[1]?.textContent).toBe('Q2');
    });

    it('treats non-boolean multiSelect values as false', () => {
      const input = {
        questions: [
          { question: 'Pick one', options: ['A', 'B'], multiSelect: 'false' },
        ],
      };
      const { container } = renderWidget(input);

      const items = findItems(container).filter(
        (i) => !i.hasClass('claudian-ask-custom-item'),
      );
      items[0]?.click();

      expect(container.querySelector<HTMLElement>('.claudian-ask-review-title')?.textContent).toBe('Review your answers');
    });

    it('truncates header to 12 characters', () => {
      const input = makeInput([
        { question: 'Q', options: ['A'], header: 'VeryLongHeaderText' },
      ]);
      const { container } = renderWidget(input);
      const tabLabels = Array.from(container.querySelectorAll<HTMLElement>('.claudian-ask-tab-label'));
      expect(tabLabels[0]?.textContent).toBe('VeryLongHead');
    });
  });

  describe('coerceOption / extractLabel', () => {
    it('handles string options', () => {
      const input = makeInput([{ question: 'Q', options: ['Yes', 'No'] }]);
      const { container } = renderWidget(input);
      const labels = Array.from(container.querySelectorAll<HTMLElement>('.claudian-ask-item-label'))
        .map((el) => el.textContent);
      expect(labels).toContain('Yes');
      expect(labels).toContain('No');
    });

    it('extracts label from object with label property', () => {
      const input = makeInput([
        {
          question: 'Q',
          options: [
            { label: 'Option A', description: 'desc A' },
            { value: 'Option B' },
            { text: 'Option C' },
            { name: 'Option D' },
          ],
        },
      ]);
      const { container } = renderWidget(input);
      const labels = Array.from(container.querySelectorAll<HTMLElement>('.claudian-ask-item-label'))
        .map((el) => el.textContent);
      expect(labels).toContain('Option A');
      expect(labels).toContain('Option B');
      expect(labels).toContain('Option C');
      expect(labels).toContain('Option D');
    });

    it('shows description when provided', () => {
      const input = makeInput([
        { question: 'Q', options: [{ label: 'A', description: 'Some desc' }] },
      ]);
      const { container } = renderWidget(input);
      const descEl = container.querySelector<HTMLElement>('.claudian-ask-item-desc');
      expect(descEl?.textContent).toBe('Some desc');
    });

    it('coerces non-string/non-object options to string', () => {
      const input = makeInput([{ question: 'Q', options: [42] }]);
      const { container } = renderWidget(input);
      const labels = Array.from(container.querySelectorAll<HTMLElement>('.claudian-ask-item-label'))
        .map((el) => el.textContent);
      expect(labels).toContain('42');
    });

    it('uses option value for resolution when provided', () => {
      const input = makeInput([
        {
          question: 'Q',
          options: [{ label: 'Approve and remember', value: 'allow_with_policy' }],
        },
      ]);
      const { container, resolve } = renderWidget(input);
      const labels = Array.from(container.querySelectorAll<HTMLElement>('.claudian-ask-item-label'))
        .map((el) => el.textContent);
      expect(labels).toContain('Approve and remember');
      findItems(container)[0]?.click();
      findItems(container)[0]?.click();
      expect(resolve).toHaveBeenCalledWith({ Q: 'allow_with_policy' });
    });
  });

  describe('selectOption', () => {
    it('selects single-select option via click', () => {
      const input = makeInput([
        { question: 'Pick one', options: ['A', 'B'] },
      ]);
      const { container, resolve } = renderWidget(input);

      // Click first option
      const items = findItems(container).filter(
        (i) => !i.hasClass('claudian-ask-custom-item'),
      );
      items[0]?.click();
      vi.advanceTimersByTime(200);

      // Auto-advanced to submit tab — now submit
      const submitItems = Array.from(container.querySelectorAll<HTMLElement>('.claudian-ask-item'));
      const submitRow = submitItems.find(
        (i) => !i.hasClass('claudian-ask-custom-item'),
      );
      submitRow?.click();

      expect(resolve).toHaveBeenCalledWith({ 'Pick one': 'A' });
    });

    it('toggles multi-select options', () => {
      const input = makeInput([
        { question: 'Pick many', options: ['X', 'Y', 'Z'], multiSelect: true },
      ]);
      const { container } = renderWidget(input);

      const items = findItems(container).filter(
        (i) => !i.hasClass('claudian-ask-custom-item'),
      );
      // Select X and Y
      items[0]?.click();
      items[1]?.click();

      // Check marks for multi-select
      const checks = Array.from(container.querySelectorAll<HTMLElement>('.claudian-ask-check'));
      const checkedCount = checks.filter((c) => c.hasClass('is-checked')).length;
      expect(checkedCount).toBe(2);

      // Deselect X
      items[0]?.click();
      const checksAfter = Array.from(container.querySelectorAll<HTMLElement>('.claudian-ask-check'));
      const checkedAfter = checksAfter.filter((c) => c.hasClass('is-checked')).length;
      expect(checkedAfter).toBe(1);
    });
  });

  describe('handleSubmit', () => {
    it('does not submit when not all questions are answered', () => {
      const input = makeInput([
        { question: 'Q1', options: ['A'] },
        { question: 'Q2', options: ['B'] },
      ]);
      const { container, resolve } = renderWidget(input);

      // Navigate to submit tab without answering
      const root = findRoot(container);
      fireKeyDown(root, 'Tab');

      // Try to submit
      fireKeyDown(root, 'Enter');
      // Should navigate to submit tab first, not resolve
      // Eventually press Enter on submit tab
      fireKeyDown(root, 'Tab');
      fireKeyDown(root, 'Enter');
      // Still not submitted because not all answered
      expect(resolve).not.toHaveBeenCalled();
    });

    it('submits answers with correct question-answer mapping', () => {
      const input = makeInput([
        { question: 'Color?', options: ['Red', 'Blue'] },
        { question: 'Size?', options: ['S', 'M', 'L'] },
      ]);
      const { container, resolve } = renderWidget(input);

      // Select "Red" for Q1
      const items = findItems(container).filter(
        (i) => !i.hasClass('claudian-ask-custom-item'),
      );
      items[0]?.click();
      vi.advanceTimersByTime(200);

      // Now on Q2 — select "M" (index 1)
      const q2Items = findItems(container).filter(
        (i) => !i.hasClass('claudian-ask-custom-item'),
      );
      q2Items[1]?.click();
      vi.advanceTimersByTime(200);

      // Now on submit tab — click submit
      const submitItems = Array.from(container.querySelectorAll<HTMLElement>('.claudian-ask-item'));
      const submitRow = submitItems.find(
        (i) => !i.hasClass('claudian-ask-custom-item'),
      );
      submitRow?.click();

      expect(resolve).toHaveBeenCalledWith({
        'Color?': 'Red',
        'Size?': 'M',
      });
    });

    it('submits multi-select answers as arrays instead of joining them into one string', () => {
      const input = makeInput([
        { question: 'Pick many', options: ['X', 'Y', 'Z'], multiSelect: true },
      ]);
      const { container, resolve } = renderWidget(input);

      const items = findItems(container).filter(
        (i) => !i.hasClass('claudian-ask-custom-item'),
      );
      items[0]?.click();
      items[1]?.click();

      const root = findRoot(container);
      fireKeyDown(root, 'Tab');
      fireKeyDown(root, 'Enter');

      expect(resolve).toHaveBeenCalledWith({
        'Pick many': ['X', 'Y'],
      });
    });
  });

  describe('question metadata', () => {
    it('shows custom input only when the question allows "other"', () => {
      const disallowOtherInput = {
        questions: [{ question: 'Pick one', options: ['A', 'B'], isOther: false }],
      };
      const { container: noOther } = renderWidget(disallowOtherInput);
      expect(Array.from(noOther.querySelectorAll<HTMLElement>('.claudian-ask-custom-item'))).toHaveLength(0);

      const allowOtherInput = {
        questions: [{ question: 'Pick one', options: ['A', 'B'], isOther: true }],
      };
      const { container: withOther } = renderWidget(allowOtherInput);
      expect(Array.from(withOther.querySelectorAll<HTMLElement>('.claudian-ask-custom-item'))).toHaveLength(1);
    });
  });

  describe('question id keying', () => {
    it('keys submit results by question id when id is provided', () => {
      const input = {
        questions: [
          { id: 'color_q', question: 'Favorite color?', options: ['Red', 'Blue'], header: 'Color' },
          { id: 'size_q', question: 'Preferred size?', options: ['S', 'M'], header: 'Size' },
        ],
      };
      const { container, resolve } = renderWidget(input);

      // Select "Red" for Q1
      const items = findItems(container).filter(
        (i) => !i.hasClass('claudian-ask-custom-item'),
      );
      items[0]?.click();
      vi.advanceTimersByTime(200);

      // Select "M" for Q2
      const q2Items = findItems(container).filter(
        (i) => !i.hasClass('claudian-ask-custom-item'),
      );
      q2Items[1]?.click();
      vi.advanceTimersByTime(200);

      // Submit
      const submitItems = Array.from(container.querySelectorAll<HTMLElement>('.claudian-ask-item'));
      const submitRow = submitItems.find(
        (i) => !i.hasClass('claudian-ask-custom-item'),
      );
      submitRow?.click();

      expect(resolve).toHaveBeenCalledWith({
        color_q: 'Red',
        size_q: 'M',
      });
    });
  });

  describe('abort lifecycle', () => {
    it('resolves null when signal is aborted', () => {
      const controller = new AbortController();
      const input = makeInput([{ question: 'Q', options: ['A'] }]);
      const { resolve } = renderWidget(input, controller.signal);

      expect(resolve).not.toHaveBeenCalled();
      controller.abort();
      expect(resolve).toHaveBeenCalledWith(null);
    });

    it('does not double-resolve on abort after manual resolve', () => {
      const controller = new AbortController();
      const addListener = vi.spyOn(controller.signal, 'addEventListener');
      const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
      try {
        const input = makeInput([{ question: 'Q', options: ['A'] }]);
        const { container, resolve } = renderWidget(input, controller.signal);
        expect(addListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
        const abortHandler = addListener.mock.calls[0][1];

        const root = findRoot(container);
        fireKeyDown(root, 'Escape');
        expect(resolve).toHaveBeenCalledTimes(1);
        expect(resolve).toHaveBeenCalledWith(null);
        expect(removeListener).toHaveBeenCalledWith('abort', abortHandler);

        controller.abort();
        expect(resolve).toHaveBeenCalledTimes(1);
      } finally {
        addListener.mockRestore();
        removeListener.mockRestore();
      }
    });
  });

  describe('destroy', () => {
    it('resolves null on destroy', () => {
      const input = makeInput([{ question: 'Q', options: ['A'] }]);
      const { resolve, widget } = renderWidget(input);

      widget.destroy();
      expect(resolve).toHaveBeenCalledWith(null);
    });

    it('does not double-resolve if already resolved', () => {
      const input = makeInput([{ question: 'Q', options: ['A'] }]);
      const { container, resolve, widget } = renderWidget(input);

      const root = findRoot(container);
      fireKeyDown(root, 'Escape');
      expect(resolve).toHaveBeenCalledTimes(1);

      widget.destroy();
      expect(resolve).toHaveBeenCalledTimes(1);
    });
  });

  describe('keyboard navigation', () => {
    it('Escape resolves null', () => {
      const input = makeInput([{ question: 'Q', options: ['A', 'B'] }]);
      const { container, resolve } = renderWidget(input);

      const root = findRoot(container);
      fireKeyDown(root, 'Escape');
      expect(resolve).toHaveBeenCalledWith(null);
    });

    it('ArrowDown moves focus down', () => {
      const input = makeInput([{ question: 'Q', options: ['A', 'B'] }]);
      const { container } = renderWidget(input);
      const root = findRoot(container);

      // Initially focused on item 0
      fireKeyDown(root, 'ArrowDown');

      const items = findItems(container);
      // Item 1 should now be focused
      expect(items[1]?.hasClass('is-focused')).toBe(true);
    });

    it('ArrowDown clamps at the single option', () => {
      const input = makeInput([{ question: 'Q', options: ['A'] }]);
      const { container } = renderWidget(input);
      const root = findRoot(container);

      // Press ArrowDown many times
      fireKeyDown(root, 'ArrowDown');
      fireKeyDown(root, 'ArrowDown');
      fireKeyDown(root, 'ArrowDown');

      // The single option stays focused after repeated navigation.
      const items = findItems(container);
      expect(items).toHaveLength(1);
      expect(items[items.length - 1]?.hasClass('is-focused')).toBe(true);
    });

    it('ArrowDown clamps at last option when custom input is hidden', () => {
      const input = makeInput([{ question: 'Q', options: ['A', 'B'] }]);
      const container = document.body.createDiv();
      const resolve = vi.fn();
      const widget = new InlineAskUserQuestion(container, input, resolve, undefined, { showCustomInput: false });
      widget.render();
  vi.advanceTimersByTime(20);
  onTestFinished(() => widget.destroy());
      const root = findRoot(container);

      fireKeyDown(root, 'ArrowDown');
      fireKeyDown(root, 'ArrowDown');
      fireKeyDown(root, 'ArrowDown');

      const items = findItems(container);
      expect(items).toHaveLength(2);
      expect(items[1]?.hasClass('is-focused')).toBe(true);
    });

    it('ArrowUp moves focus up and clamps at 0', () => {
      const input = makeInput([{ question: 'Q', options: ['A', 'B'] }]);
      const { container } = renderWidget(input);
      const root = findRoot(container);

      // Move down then back up past 0
      fireKeyDown(root, 'ArrowDown');
      fireKeyDown(root, 'ArrowUp');
      fireKeyDown(root, 'ArrowUp');

      const items = findItems(container);
      expect(items[0]?.hasClass('is-focused')).toBe(true);
    });

    it('Tab navigates to next question tab', () => {
      const input = makeInput([
        { question: 'Q1', options: ['A'] },
        { question: 'Q2', options: ['B'] },
      ]);
      const { container } = renderWidget(input);
      const root = findRoot(container);

      fireKeyDown(root, 'Tab');

      // Should now be on Q2 — check tab bar
      const tabs = Array.from(container.querySelectorAll<HTMLElement>('.claudian-ask-tab'));
      expect(tabs[1]?.hasClass('is-active')).toBe(true);
    });

    it('Shift+Tab navigates to previous tab', () => {
      const input = makeInput([
        { question: 'Q1', options: ['A'] },
        { question: 'Q2', options: ['B'] },
      ]);
      const { container } = renderWidget(input);
      const root = findRoot(container);

      // Go to Q2 then back
      fireKeyDown(root, 'Tab');
      fireKeyDown(root, 'Tab', { shiftKey: true });

      const tabs = Array.from(container.querySelectorAll<HTMLElement>('.claudian-ask-tab'));
      expect(tabs[0]?.hasClass('is-active')).toBe(true);
    });

    it('ArrowRight navigates forward on question tab', () => {
      const input = makeInput([
        { question: 'Q1', options: ['A'] },
        { question: 'Q2', options: ['B'] },
      ]);
      const { container } = renderWidget(input);
      const root = findRoot(container);

      fireKeyDown(root, 'ArrowRight');

      const tabs = Array.from(container.querySelectorAll<HTMLElement>('.claudian-ask-tab'));
      expect(tabs[1]?.hasClass('is-active')).toBe(true);
    });

    it('Enter on submit tab calls handleSubmit', () => {
      const input = makeInput([{ question: 'Q', options: ['A'] }]);
      const { container, resolve } = renderWidget(input);
      const root = findRoot(container);

      // Select option A
      const items = findItems(container).filter(
        (i) => !i.hasClass('claudian-ask-custom-item'),
      );
      items[0]?.click();
      vi.advanceTimersByTime(200);

      // Now on submit tab, Enter should submit
      fireKeyDown(root, 'Enter');

      expect(resolve).toHaveBeenCalledWith({ Q: 'A' });
    });

    it('Enter on cancel row resolves null', () => {
      const input = makeInput([{ question: 'Q', options: ['A'] }]);
      const { container, resolve } = renderWidget(input);
      const root = findRoot(container);

      // Select A and auto-advance to submit
      const items = findItems(container).filter(
        (i) => !i.hasClass('claudian-ask-custom-item'),
      );
      items[0]?.click();
      vi.advanceTimersByTime(200);

      // Move focus to cancel row
      fireKeyDown(root, 'ArrowDown');
      fireKeyDown(root, 'Enter');

      expect(resolve).toHaveBeenCalledWith(null);
    });

    it('Enter on question option selects it', () => {
      const input = makeInput([{ question: 'Q', options: ['A', 'B'] }]);
      const { container } = renderWidget(input);
      const root = findRoot(container);

      // Focus is on item 0, press Enter to select
      fireKeyDown(root, 'Enter');
      vi.advanceTimersByTime(200);

      // After auto-advance we should be on submit tab
      const tabs = Array.from(container.querySelectorAll<HTMLElement>('.claudian-ask-tab'));
      const submitTab = tabs[tabs.length - 1];
      expect(submitTab?.hasClass('is-active')).toBe(true);

    });

    it('click on custom row focuses it', () => {
      const input = makeInput([{ question: 'Q', options: ['A', 'B'], isOther: true }]);
      const { container } = renderWidget(input);

      const items = findItems(container);
      const customItem = items.find((i) => i.hasClass('claudian-ask-custom-item'));
      customItem?.click();

      expect(customItem?.hasClass('is-focused')).toBe(true);
    });

    it('ArrowUp from custom row blurs input focus and moves to option above', () => {
      const input = makeInput([{ question: 'Q', options: ['A', 'B'], isOther: true }]);
      const { container } = renderWidget(input);
      const root = findRoot(container);

      const items = findItems(container);
      const customItem = items.find((i) => i.hasClass('claudian-ask-custom-item'));
      // Simulate click on custom row (focusedItemIndex = options.length, isInputFocused = true)
      customItem?.click();

      fireKeyDown(root, 'ArrowUp');

      // Focus should move to the last regular option (index = options.length - 1)
      const updatedItems = findItems(container);
      const lastOption = updatedItems.filter(
        (i) => !i.hasClass('claudian-ask-custom-item'),
      );
      expect(lastOption[lastOption.length - 1]?.hasClass('is-focused')).toBe(true);
      expect(customItem?.hasClass('is-focused')).toBe(false);
    });

    it('Enter on custom item then Enter again advances to next tab', () => {
      const input = makeInput([
        { question: 'Q1', options: ['A'], isOther: true },
        { question: 'Q2', options: ['B'] },
      ]);
      const { container } = renderWidget(input);
      const root = findRoot(container);

      // Arrow down to custom item
      fireKeyDown(root, 'ArrowDown');
      fireKeyDown(root, 'ArrowDown');

      // First Enter activates input
      fireKeyDown(root, 'Enter');
      expect(Array.from(container.querySelectorAll<HTMLElement>('.claudian-ask-tab'))[0]?.hasClass('is-active')).toBe(true);
      // Second Enter advances
      fireKeyDown(root, 'Enter');

      // Should be on Q2 tab now
      const tabs = Array.from(container.querySelectorAll<HTMLElement>('.claudian-ask-tab'));
      expect(tabs[1]?.hasClass('is-active')).toBe(true);
    });

    it('ArrowDown from custom input blurs and clamps at max', () => {
      const input = makeInput([{ question: 'Q', options: ['A', 'B'], isOther: true }]);
      const { container } = renderWidget(input);
      const root = findRoot(container);

      const items = findItems(container);
      const customItem = items.find((i) => i.hasClass('claudian-ask-custom-item'));
      customItem?.click();

      fireKeyDown(root, 'ArrowDown');

      // Custom row is last item, ArrowDown clamps — focus stays on custom row (navigation mode)
      expect(customItem?.hasClass('is-focused')).toBe(true);
    });

    it('Escape from custom input returns to navigation without cancelling dialog', () => {
      const input = makeInput([
        { question: 'Q1', options: ['A'], isOther: true },
        { question: 'Q2', options: ['B'] },
      ]);
      const { container, resolve } = renderWidget(input);
      const root = findRoot(container);

      // Navigate to custom input and activate
      fireKeyDown(root, 'ArrowDown'); // focus on custom row (index 1)
      fireKeyDown(root, 'Enter');     // activate input

      // Escape should exit input mode, not cancel
      fireKeyDown(root, 'Escape');

      // Dialog should NOT be resolved
      expect(resolve).not.toHaveBeenCalled();

      // Should still be on Q1 tab
      const tabs = Array.from(container.querySelectorAll<HTMLElement>('.claudian-ask-tab'));
      expect(tabs[0]?.hasClass('is-active')).toBe(true);

      // Custom row should still be focused in navigation mode
      const items = findItems(container);
      const customItem = items.find((i) => i.hasClass('claudian-ask-custom-item'));
      expect(customItem?.hasClass('is-focused')).toBe(true);
    });

    it('Enter from custom input commits text and advances tab', () => {
      const input = makeInput([
        { question: 'Q1', options: ['A'], isOther: true },
        { question: 'Q2', options: ['B'] },
      ]);
      const { container } = renderWidget(input);
      const root = findRoot(container);

      // Navigate to custom input and activate
      fireKeyDown(root, 'ArrowDown'); // focus on custom row (index 1)
      fireKeyDown(root, 'Enter');     // activate input

      // Simulate typing text
      const inputEl = within(container).getByRole('textbox', { name: 'Q1' });
      fireEvent.input(inputEl, { target: { value: 'my custom text' } });

      // Enter should commit and advance
      fireKeyDown(root, 'Enter');

      // Should be on Q2 tab
      const tabs = Array.from(container.querySelectorAll<HTMLElement>('.claudian-ask-tab'));
      expect(tabs[1]?.hasClass('is-active')).toBe(true);
    });

    it('does not advance from custom input on Enter during IME composition', () => {
      const input = makeInput([
        { question: 'Q1', options: ['A'], isOther: true },
        { question: 'Q2', options: ['B'] },
      ]);
      const { container } = renderWidget(input);
      const root = findRoot(container);
      const customItem = findItems(container).find((item) =>
        item.hasClass('claudian-ask-custom-item'),
      );

      customItem?.click();
      fireKeyDown(root, 'Enter', { isComposing: true });

      const tabs = Array.from(container.querySelectorAll<HTMLElement>('.claudian-ask-tab'));
      expect(tabs[0]?.hasClass('is-active')).toBe(true);
      expect(document.activeElement).toBe(within(container).getByRole('textbox', { name: 'Q1' }));
    });
  });
});

function renderImmediateWidget(
  input: Record<string, unknown>,
  config?: InlineAskQuestionConfig,
): { container: HTMLElement; resolve: Mock; widget: InlineAskUserQuestion } {
  const container = document.body.createDiv();
  const resolve = vi.fn();
  const widget = new InlineAskUserQuestion(
    container,
    input,
    resolve,
    undefined,
    { immediateSelect: true, showCustomInput: false, ...config },
  );
  widget.render();
  vi.advanceTimersByTime(20);
  onTestFinished(() => widget.destroy());
  return { container, resolve, widget };
}

describe('InlineAskUserQuestion - immediateSelect mode', () => {
  describe('multi-question fallback', () => {
    it('falls back to tab-bar rendering when questions.length !== 1', () => {
      const input = makeInput([
        { question: 'Q1', options: ['A'] },
        { question: 'Q2', options: ['B'] },
      ]);
      const { container, resolve } = renderImmediateWidget(input);

      // Should render tab bar (immediateSelect disabled due to multi-question)
      const tabBar = container.querySelector<HTMLElement>('.claudian-ask-tab-bar');
      expect(tabBar).not.toBeNull();
      const tabs = Array.from(container.querySelectorAll<HTMLElement>('.claudian-ask-tab'));
      expect(tabs.length).toBeGreaterThan(0);

      // Should NOT resolve immediately on click (normal multi-tab flow)
      const items = findItems(container).filter(
        (i) => !i.hasClass('claudian-ask-custom-item'),
      );
      items[0]?.click();
      expect(resolve).not.toHaveBeenCalled();
    });
  });

  describe('rendering', () => {
    it('does not render tab bar', () => {
      const input = makeInput([{ question: 'Pick', options: ['A', 'B'] }]);
      const { container } = renderImmediateWidget(input);
      const tabBar = container.querySelector<HTMLElement>('.claudian-ask-tab-bar');
      expect(tabBar).toBeNull();
      const tabs = Array.from(container.querySelectorAll<HTMLElement>('.claudian-ask-tab'));
      expect(tabs).toHaveLength(0);
    });

    it('does not render custom input row', () => {
      const input = makeInput([{ question: 'Pick', options: ['A', 'B'], isOther: true }]);
      const { container } = renderImmediateWidget(input);
      const customItems = Array.from(container.querySelectorAll<HTMLElement>('.claudian-ask-custom-item'));
      expect(customItems).toHaveLength(0);
    });

    it('uses custom title when provided', () => {
      const input = makeInput([{ question: 'Pick', options: ['A'] }]);
      const { container } = renderImmediateWidget(input, { title: 'Permission required' });
      const title = container.querySelector<HTMLElement>('.claudian-ask-inline-title');
      expect(title?.textContent).toBe('Permission required');
    });

    it('renders headerEl between title and content', () => {
      const headerEl = document.createElement('div');
      headerEl.addClass('claudian-ask-approval-info');
      const input = makeInput([{ question: 'Pick', options: ['A'] }]);
      const { container } = renderImmediateWidget(input, { headerEl });
      const root = findRoot(container);
      expect(Array.from(root.children).some((c) => c.hasClass('claudian-ask-approval-info'))).toBe(true);
      expect(root.children[0].hasClass('claudian-ask-inline-title')).toBe(true);
      expect(root.children[1]).toBe(headerEl);
      expect(root.children[2].hasClass('claudian-ask-content')).toBe(true);
    });
  });

  describe('selection', () => {
    it('resolves immediately on click', () => {
      const input = makeInput([{ question: 'Pick', options: ['A', 'B'] }]);
      const { container, resolve } = renderImmediateWidget(input);

      const items = findItems(container).filter(
        (i) => !i.hasClass('claudian-ask-custom-item'),
      );
      items[0]?.click();

      expect(resolve).toHaveBeenCalledWith({ Pick: 'A' });
    });

    it('resolves with second option on click', () => {
      const input = makeInput([{ question: 'Pick', options: ['A', 'B'] }]);
      const { container, resolve } = renderImmediateWidget(input);

      const items = findItems(container).filter(
        (i) => !i.hasClass('claudian-ask-custom-item'),
      );
      items[1]?.click();

      expect(resolve).toHaveBeenCalledWith({ Pick: 'B' });
    });

    it('keys immediate-select result by id when provided', () => {
      const input = {
        questions: [
          { id: 'approval_q', question: 'Allow execution?', options: ['Yes', 'No'], header: 'Approve' },
        ],
      };
      const { container, resolve } = renderImmediateWidget(input);

      const items = findItems(container).filter(
        (i) => !i.hasClass('claudian-ask-custom-item'),
      );
      items[0]?.click();

      expect(resolve).toHaveBeenCalledWith({ approval_q: 'Yes' });
    });
  });

  describe('keyboard navigation', () => {
    it('ArrowDown/Up navigates focus', () => {
      const input = makeInput([{ question: 'Pick', options: ['A', 'B', 'C'] }]);
      const { container } = renderImmediateWidget(input);
      const root = findRoot(container);

      fireKeyDown(root, 'ArrowDown');
      const items = findItems(container);
      expect(items[1]?.hasClass('is-focused')).toBe(true);

      fireKeyDown(root, 'ArrowUp');
      const items2 = findItems(container);
      expect(items2[0]?.hasClass('is-focused')).toBe(true);
    });

    it('Enter selects and resolves immediately', () => {
      const input = makeInput([{ question: 'Pick', options: ['A', 'B'] }]);
      const { container, resolve } = renderImmediateWidget(input);
      const root = findRoot(container);

      // Move to second option and press Enter
      fireKeyDown(root, 'ArrowDown');
      fireKeyDown(root, 'Enter');

      expect(resolve).toHaveBeenCalledWith({ Pick: 'B' });
    });

    it('Escape cancels', () => {
      const input = makeInput([{ question: 'Pick', options: ['A', 'B'] }]);
      const { container, resolve } = renderImmediateWidget(input);
      const root = findRoot(container);

      fireKeyDown(root, 'Escape');
      expect(resolve).toHaveBeenCalledWith(null);
    });

    it('Tab does not switch tabs (no-op in immediateSelect)', () => {
      const input = makeInput([{ question: 'Pick', options: ['A', 'B'] }]);
      const { container, resolve } = renderImmediateWidget(input);
      const root = findRoot(container);

      fireKeyDown(root, 'ArrowDown');
      expect(findItems(container)[1]?.hasClass('is-focused')).toBe(true);
      fireKeyDown(root, 'Tab');
      expect(resolve).not.toHaveBeenCalled();
      const items = findItems(container);
      expect(items.length).toBeGreaterThan(0);
      expect(items[1]?.hasClass('is-focused')).toBe(true);
      fireKeyDown(root, 'Enter');
      expect(resolve).toHaveBeenCalledWith({ Pick: 'B' });
    });

    it('ArrowDown clamps at last option', () => {
      const input = makeInput([{ question: 'Pick', options: ['A', 'B'] }]);
      const { container } = renderImmediateWidget(input);
      const root = findRoot(container);

      fireKeyDown(root, 'ArrowDown');
      fireKeyDown(root, 'ArrowDown');
      fireKeyDown(root, 'ArrowDown');

      const items = findItems(container);
      expect(items[1]?.hasClass('is-focused')).toBe(true);
    });
  });
});
