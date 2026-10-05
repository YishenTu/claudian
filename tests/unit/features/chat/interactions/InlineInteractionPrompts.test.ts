import { createMockEl } from '@test/helpers/MockElement';

import { InlineInteractionPrompts } from '@/features/chat/interactions/InlineInteractionPrompts';

describe('InlineInteractionPrompts approval details', () => {
  it('makes long approval details a named keyboard-scrollable region', () => {
    const parentEl = createMockEl();
    const inputContainerEl = createMockEl();
    inputContainerEl.parentElement = parentEl;
    parentEl.appendChild(inputContainerEl);
    const prompts = new InlineInteractionPrompts({
      getPromptParentEl: () => inputContainerEl.parentElement as any,
      getSuppressedEl: () => inputContainerEl as any,
    });

    const pending = prompts.requestApproval(
      'approval-id',
      'Bash',
      {},
      'A long command description',
    );
    const descriptionEl = parentEl.querySelector('.claudian-ask-approval-desc');

    expect(descriptionEl?.getAttribute('tabindex')).toBe('0');
    expect(descriptionEl?.getAttribute('role')).toBe('region');
    expect(descriptionEl?.getAttribute('aria-label')).toBe('Bash approval details');

    const stopPropagation = jest.fn();
    const preventDefault = jest.fn();
    descriptionEl?.dispatchEvent({
      type: 'keydown',
      key: 'ArrowDown',
      preventDefault,
      stopPropagation,
    });
    descriptionEl?.dispatchEvent({
      type: 'keydown',
      key: 'Enter',
      preventDefault,
      stopPropagation,
    });

    expect(stopPropagation).toHaveBeenCalledTimes(2);
    expect(preventDefault).not.toHaveBeenCalled();

    prompts.dismiss('approval-id');
    return pending;
  });
});

describe('InlineInteractionPrompts presentation restore', () => {
  it('resumes the newest response when an older generation prompt settles last', async () => {
    const parentEl = createMockEl();
    let generation = 1;
    const resumed: number[] = [];
    const prompts = new InlineInteractionPrompts({
      getPromptParentEl: () => parentEl as any,
      onBeforeShow: () => {
        const shownGeneration = generation;
        return () => resumed.push(shownGeneration);
      },
    });

    const question = {
      questions: [{ id: '0', question: 'Which check?', options: [{ label: 'History' }] }],
    };
    const first = prompts.askUserQuestion('first', question);
    generation = 2;
    const second = prompts.askUserQuestion('second', question);

    prompts.dismiss('second');
    await second;
    expect(resumed).toEqual([]);

    prompts.dismiss('first');
    await first;
    expect(resumed).toEqual([2]);
  });
});
