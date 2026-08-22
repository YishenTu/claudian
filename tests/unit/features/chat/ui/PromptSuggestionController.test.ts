import { createMockEl } from '@test/helpers/MockElement';

import { PromptSuggestionController } from '@/features/chat/ui/PromptSuggestionController';

describe('PromptSuggestionController', () => {
  function createController(): {
    controller: PromptSuggestionController;
    inputEl: HTMLTextAreaElement;
  } {
    const inputEl = createMockEl('textarea') as HTMLTextAreaElement;
    inputEl.placeholder = 'Ask Claude';
    return {
      controller: new PromptSuggestionController(inputEl),
      inputEl,
    };
  }

  it.each(['Tab', 'ArrowRight'])('accepts a visible suggestion with %s', (key) => {
    const { controller, inputEl } = createController();
    const inputEvents: Event[] = [];
    inputEl.addEventListener('input', event => inputEvents.push(event));
    controller.show('Review the changed files');
    const preventDefault = jest.fn();
    const event = {
      key,
      altKey: false,
      ctrlKey: false,
      isComposing: false,
      metaKey: false,
      preventDefault,
      shiftKey: false,
    } as unknown as KeyboardEvent;

    expect(controller.handleKeydown(event)).toBe(true);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(inputEl.value).toBe('Review the changed files');
    expect(inputEl.placeholder).toBe('Ask Claude');
    expect(inputEvents).toHaveLength(1);
    expect(controller.isVisible).toBe(false);
  });

  it('does not take modified, composing, or non-empty input keydowns', () => {
    const { controller, inputEl } = createController();
    controller.show('Review the changed files');

    expect(controller.handleKeydown({
      key: 'Tab',
      altKey: false,
      ctrlKey: true,
      isComposing: false,
      metaKey: false,
      shiftKey: false,
    } as KeyboardEvent)).toBe(false);
    expect(controller.handleKeydown({
      key: 'ArrowRight',
      altKey: false,
      ctrlKey: false,
      isComposing: true,
      metaKey: false,
      shiftKey: false,
    } as KeyboardEvent)).toBe(false);
    inputEl.value = 'draft';
    expect(controller.handleKeydown({
      key: 'Tab',
      altKey: false,
      ctrlKey: false,
      isComposing: false,
      metaKey: false,
      shiftKey: false,
    } as KeyboardEvent)).toBe(false);
    expect(inputEl.value).toBe('draft');
  });

  it('invalidates a suggestion on input without overwriting another mode placeholder', () => {
    const { controller, inputEl } = createController();
    controller.show('Review the changed files');
    inputEl.placeholder = 'Run a bash command';
    inputEl.value = '!';

    controller.handleInputChange();

    expect(controller.isVisible).toBe(false);
    expect(inputEl.placeholder).toBe('Run a bash command');
  });
});
