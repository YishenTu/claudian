import { createMockEl } from '@test/helpers/mockElement';

import { InlineAskUserQuestion } from '@/features/chat/rendering/InlineAskUserQuestion';

beforeAll(() => {
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  };
  // Mock document.activeElement for focus checks in updateFocusIndicator
  (globalThis as any).document = { activeElement: null };
});

function makeInput(
  questions: Array<{
    question: string;
    options: unknown[];
    multiSelect?: boolean;
    header?: string;
  }>,
): Record<string, unknown> {
  return { questions };
}

function renderWidget(
  input: Record<string, unknown>,
  signal?: AbortSignal,
): { container: any; resolve: jest.Mock; widget: InlineAskUserQuestion } {
  const container = createMockEl();
  const resolve = jest.fn();
  const widget = new InlineAskUserQuestion(container, input, resolve, signal);
  widget.render();
  return { container, resolve, widget };
}

function fireKeyDown(
  root: any,
  key: string,
  opts: { shiftKey?: boolean } = {},
): void {
  const event = {
    type: 'keydown',
    key,
    shiftKey: opts.shiftKey ?? false,
    preventDefault: jest.fn(),
    stopPropagation: jest.fn(),
  };
  root.dispatchEvent(event);
}

function findRoot(container: any): any {
  return container.querySelector('.claudian-ask-question-inline');
}

function findItems(container: any): any[] {
  return container.querySelectorAll('claudian-ask-item');
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

    it('filters out questions with no options', () => {
      const input = makeInput([
        { question: 'Q1', options: [] },
        { question: 'Q2', options: ['A'] },
      ]);
      const { resolve } = renderWidget(input);
      // Should render — Q2 is valid
      expect(resolve).not.toHaveBeenCalled();
    });

    it('resolves null when all questions have empty options', () => {
      const input = makeInput([
        { question: 'Q1', options: [] },
        { question: 'Q2', options: [] },
      ]);
      const { resolve } = renderWidget(input);
      expect(resolve).toHaveBeenCalledWith(null);
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
      const { resolve } = renderWidget(input);
      // Only "Valid" survives — widget should render
      expect(resolve).not.toHaveBeenCalled();
    });

    it('deduplicates options with the same label', () => {
      const input = makeInput([
        { question: 'Pick', options: ['A', 'A', 'B'] },
      ]);
      const { container } = renderWidget(input);
      // Find option items (excluding custom input row)
      const items = container.querySelectorAll('claudian-ask-item');
      // 2 unique options + 1 custom input row = 3
      const optionLabels = items
        .filter((item: any) => !item.hasClass('claudian-ask-custom-item'))
        .map((item: any) => {
          const labelEl = item.querySelector('claudian-ask-item-label');
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
      const tabLabels = container.querySelectorAll('claudian-ask-tab-label');
      // Tab labels: MyHeader, Q2, Submit
      expect(tabLabels[0]?.textContent).toBe('MyHeader');
      expect(tabLabels[1]?.textContent).toBe('Q2');
    });

    it('truncates header to 12 characters', () => {
      const input = makeInput([
        { question: 'Q', options: ['A'], header: 'VeryLongHeaderText' },
      ]);
      const { container } = renderWidget(input);
      const tabLabels = container.querySelectorAll('claudian-ask-tab-label');
      expect(tabLabels[0]?.textContent).toBe('VeryLongHead');
    });
  });

  describe('coerceOption / extractLabel', () => {
    it('handles string options', () => {
      const input = makeInput([{ question: 'Q', options: ['Yes', 'No'] }]);
      const { container } = renderWidget(input);
      const labels = container
        .querySelectorAll('claudian-ask-item-label')
        .map((el: any) => el.textContent);
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
      const labels = container
        .querySelectorAll('claudian-ask-item-label')
        .map((el: any) => el.textContent);
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
      const descEl = container.querySelector('claudian-ask-item-desc');
      expect(descEl?.textContent).toBe('Some desc');
    });

    it('coerces non-string/non-object options to string', () => {
      const input = makeInput([{ question: 'Q', options: [42] }]);
      const { container } = renderWidget(input);
      const labels = container
        .querySelectorAll('claudian-ask-item-label')
        .map((el: any) => el.textContent);
      expect(labels).toContain('42');
    });
  });

  describe('selectOption', () => {
    it('selects single-select option via click', () => {
      jest.useFakeTimers();
      const input = makeInput([
        { question: 'Pick one', options: ['A', 'B'] },
      ]);
      const { container, resolve } = renderWidget(input);

      // Click first option
      const items = findItems(container).filter(
        (i: any) => !i.hasClass('claudian-ask-custom-item'),
      );
      items[0]?.click();
      jest.advanceTimersByTime(200);

      // Auto-advanced to submit tab — now submit
      const submitItems = container.querySelectorAll('claudian-ask-item');
      const submitRow = submitItems.find(
        (i: any) => !i.hasClass('claudian-ask-custom-item'),
      );
      submitRow?.click();

      expect(resolve).toHaveBeenCalledWith({ 'Pick one': 'A' });
      jest.useRealTimers();
    });

    it('toggles multi-select options', () => {
      const input = makeInput([
        { question: 'Pick many', options: ['X', 'Y', 'Z'], multiSelect: true },
      ]);
      const { container } = renderWidget(input);

      const items = findItems(container).filter(
        (i: any) => !i.hasClass('claudian-ask-custom-item'),
      );
      // Select X and Y
      items[0]?.click();
      items[1]?.click();

      // Check marks for multi-select
      const checks = container.querySelectorAll('claudian-ask-check');
      const checkedCount = checks.filter((c: any) => c.hasClass('is-checked')).length;
      expect(checkedCount).toBe(2);

      // Deselect X
      items[0]?.click();
      const checksAfter = container.querySelectorAll('claudian-ask-check');
      const checkedAfter = checksAfter.filter((c: any) => c.hasClass('is-checked')).length;
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
      jest.useFakeTimers();
      const input = makeInput([
        { question: 'Color?', options: ['Red', 'Blue'] },
        { question: 'Size?', options: ['S', 'M', 'L'] },
      ]);
      const { container, resolve } = renderWidget(input);

      // Select "Red" for Q1
      const items = findItems(container).filter(
        (i: any) => !i.hasClass('claudian-ask-custom-item'),
      );
      items[0]?.click();
      jest.advanceTimersByTime(200);

      // Now on Q2 — select "M" (index 1)
      const q2Items = findItems(container).filter(
        (i: any) => !i.hasClass('claudian-ask-custom-item'),
      );
      q2Items[1]?.click();
      jest.advanceTimersByTime(200);

      // Now on submit tab — click submit
      const submitItems = container.querySelectorAll('claudian-ask-item');
      const submitRow = submitItems.find(
        (i: any) => !i.hasClass('claudian-ask-custom-item'),
      );
      submitRow?.click();

      expect(resolve).toHaveBeenCalledWith({
        'Color?': 'Red',
        'Size?': 'M',
      });
      jest.useRealTimers();
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
      const input = makeInput([{ question: 'Q', options: ['A'] }]);
      const { container, resolve } = renderWidget(input, controller.signal);

      // Cancel via Escape
      const root = findRoot(container);
      fireKeyDown(root, 'Escape');
      expect(resolve).toHaveBeenCalledTimes(1);

      // Abort should not trigger a second resolve
      controller.abort();
      expect(resolve).toHaveBeenCalledTimes(1);
    });

    it('cleans up abort listener on resolve', () => {
      const controller = new AbortController();
      const input = makeInput([{ question: 'Q', options: ['A'] }]);
      const { container, resolve } = renderWidget(input, controller.signal);

      // Cancel via Escape
      const root = findRoot(container);
      fireKeyDown(root, 'Escape');
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(resolve).toHaveBeenCalledWith(null);
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

    it('ArrowDown clamps at max index', () => {
      const input = makeInput([{ question: 'Q', options: ['A'] }]);
      const { container } = renderWidget(input);
      const root = findRoot(container);

      // Press ArrowDown many times
      fireKeyDown(root, 'ArrowDown');
      fireKeyDown(root, 'ArrowDown');
      fireKeyDown(root, 'ArrowDown');

      // Should not crash, max focus is 1 (option A + custom input)
      const items = findItems(container);
      // Last item (custom input) should be focused
      expect(items[items.length - 1]?.hasClass('is-focused')).toBe(true);
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
      const tabs = container.querySelectorAll('claudian-ask-tab');
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

      const tabs = container.querySelectorAll('claudian-ask-tab');
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

      const tabs = container.querySelectorAll('claudian-ask-tab');
      expect(tabs[1]?.hasClass('is-active')).toBe(true);
    });

    it('Enter on submit tab calls handleSubmit', () => {
      jest.useFakeTimers();
      const input = makeInput([{ question: 'Q', options: ['A'] }]);
      const { container, resolve } = renderWidget(input);
      const root = findRoot(container);

      // Select option A
      const items = findItems(container).filter(
        (i: any) => !i.hasClass('claudian-ask-custom-item'),
      );
      items[0]?.click();
      jest.advanceTimersByTime(200);

      // Now on submit tab, Enter should submit
      fireKeyDown(root, 'Enter');

      expect(resolve).toHaveBeenCalledWith({ Q: 'A' });
      jest.useRealTimers();
    });

    it('Enter on cancel row resolves null', () => {
      jest.useFakeTimers();
      const input = makeInput([{ question: 'Q', options: ['A'] }]);
      const { container, resolve } = renderWidget(input);
      const root = findRoot(container);

      // Select A and auto-advance to submit
      const items = findItems(container).filter(
        (i: any) => !i.hasClass('claudian-ask-custom-item'),
      );
      items[0]?.click();
      jest.advanceTimersByTime(200);

      // Move focus to cancel row
      fireKeyDown(root, 'ArrowDown');
      fireKeyDown(root, 'Enter');

      expect(resolve).toHaveBeenCalledWith(null);
      jest.useRealTimers();
    });

    it('Enter on question option selects it', () => {
      jest.useFakeTimers();
      const input = makeInput([{ question: 'Q', options: ['A', 'B'] }]);
      const { container } = renderWidget(input);
      const root = findRoot(container);

      // Focus is on item 0, press Enter to select
      fireKeyDown(root, 'Enter');
      jest.advanceTimersByTime(200);

      // After auto-advance we should be on submit tab
      const tabs = container.querySelectorAll('claudian-ask-tab');
      const submitTab = tabs[tabs.length - 1];
      expect(submitTab?.hasClass('is-active')).toBe(true);

      jest.useRealTimers();
    });
  });
});
