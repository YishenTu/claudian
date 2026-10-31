/** @vitest-environment jsdom */
import { screen } from '@testing-library/dom';
import type { Mock } from 'vitest';

import { ComposerDropdownController } from '@/shared/composer-dropdown/ComposerDropdownController';
import type {
  ComposerDropdownItem,
  ComposerDropdownSource,
  ComposerTriggerMatch,
} from '@/shared/composer-dropdown/types';

function createInput(): HTMLTextAreaElement {
  return document.body.createEl('textarea');
}

function key(key: string): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, cancelable: true });
}

function createController(...args: ConstructorParameters<typeof ComposerDropdownController>) {
  const controller = new ComposerDropdownController(...args);
  onTestFinished(() => controller.destroy());
  return controller;
}

afterEach(() => { document.body.replaceChildren(); });

function source(
  trigger: string,
  items: readonly ComposerDropdownItem[],
): ComposerDropdownSource {
  return {
    id: `source-${trigger}`,
    match(input, cursor): ComposerTriggerMatch | null {
      const before = input.slice(0, cursor);
      const index = before.lastIndexOf(trigger);
      if (index < 0 || (index > 0 && !/\s/.test(before[index - 1]))) return null;
      const query = before.slice(index + trigger.length);
      if (/\s/.test(query)) return null;
      return { atInputStart: index === 0, end: cursor, query, start: index, trigger };
    },
    load: vi.fn().mockResolvedValue(items),
    select: item => item.kind === 'value'
      ? { kind: 'replace', text: item.replacement }
      : { kind: 'none' },
  };
}

describe('ComposerDropdownController', () => {
  it('ignores a pending load after hide', async () => {
    const input = createInput();
    let resolve!: (items: readonly ComposerDropdownItem[]) => void;
    const delayed = source('@', []);
    const pending = new Promise<readonly ComposerDropdownItem[]>(done => { resolve = done; });
    (delayed.load as Mock).mockReturnValue(pending);
    const controller = createController(document.body.createDiv(), input, [delayed]);

    input.value = '@a';
    input.selectionStart = input.selectionEnd = 2;
    controller.handleInputChange();
    expect(controller.isVisible()).toBe(true);
    const signal = (delayed.load as Mock).mock.calls[0][1] as AbortSignal;
    controller.hide();
    resolve([{ id: 'late', kind: 'value', label: '@late', replacement: '@late ' }]);
    await pending;

    expect(signal.aborted).toBe(true);
    expect(controller.isVisible()).toBe(false);
    controller.destroy();
  });

  it('arbitrates sources and replaces only the active token', async () => {
    const input = createInput();
    const controller = createController(
      document.body.createDiv(),
      input,
      [
        source('/', [{ id: 'slash', kind: 'value', label: '/clear', replacement: '/clear ' }]),
        source('#', [{ id: 'ticket', kind: 'value', label: '#3', replacement: '#3 ' }]),
      ],
    );

    input.value = 'Review #3 later';
    input.selectionStart = input.selectionEnd = 9;
    controller.handleInputChange();
    await screen.findByRole('option', { name: '#3' });

    expect(controller.isVisible()).toBe(true);
    controller.handleKeydown(key('Enter'));
    expect(input.value).toBe('Review #3 later');
    expect(input.selectionStart).toBe(10);
  });

  it('prefers the nearest trigger when an earlier mention also matches', async () => {
    const input = createInput();
    const mention = source('@', [
      { id: 'file', kind: 'value', label: '@notes/spec.md', replacement: '@notes/spec.md ' },
    ]);
    mention.match = (value, cursor) => {
      const start = value.slice(0, cursor).lastIndexOf('@');
      return start < 0
        ? null
        : {
          atInputStart: start === 0,
          end: cursor,
          query: value.slice(start + 1, cursor),
          start,
          trigger: '@',
        };
    };
    const ticket = source('#', [
      { id: 'ticket', kind: 'value', label: '#12', replacement: '#12 ' },
    ]);
    const controller = createController(document.body.createDiv(), input, [mention, ticket]);

    input.value = 'Review @notes/spec.md then #1';
    input.selectionStart = input.selectionEnd = input.value.length;
    controller.handleInputChange();
    await screen.findByRole('option', { name: '#12' });
    controller.handleKeydown(key('Enter'));

    expect(input.value).toBe('Review @notes/spec.md then #12 ');
    controller.destroy();
  });

  it('preserves provider-owned trigger characters', async () => {
    const input = createInput();
    const dollar = source('$', [
      { id: 'skill', kind: 'value', label: '$review', replacement: '$review ' },
    ]);
    const controller = createController(document.body.createDiv(), input, [dollar]);

    input.value = '$rev';
    input.selectionStart = input.selectionEnd = 4;
    controller.handleInputChange();
    await screen.findByRole('option', { name: '$review' });

    expect(dollar.load).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'rev', trigger: '$' }),
      expect.any(AbortSignal),
    );
    expect(controller.isVisible()).toBe(true);
  });

  it('rematches the current input when an active source changes its trigger contract', async () => {
    const input = createInput();
    let trigger = '$';
    let invalidate = (): void => undefined;
    const providerSource = source('$', [
      { id: 'skill', kind: 'value', label: '$review', replacement: '$review ' },
    ]);
    providerSource.match = (value, cursor) => source(trigger, []).match(value, cursor);
    providerSource.subscribeInvalidation = listener => {
      invalidate = listener;
      return () => { invalidate = () => undefined; };
    };
    const controller = createController(document.body.createDiv(), input, [providerSource]);

    input.value = '$rev';
    input.selectionStart = input.selectionEnd = 4;
    controller.handleInputChange();
    await screen.findByRole('option', { name: '$review' });
    expect(controller.isVisible()).toBe(true);

    trigger = '/';
    invalidate();

    expect(controller.isVisible()).toBe(false);
    controller.destroy();
  });

  it('aborts superseded work and ignores late results', async () => {
    const input = createInput();
    let resolveFirst!: (items: readonly ComposerDropdownItem[]) => void;
    const first = new Promise<readonly ComposerDropdownItem[]>(resolve => {
      resolveFirst = resolve;
    });
    const delayed = source('@', []);
    (delayed.load as Mock)
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce([
        { id: 'new', kind: 'value', label: '@new', replacement: '@new ' },
      ]);
    const controller = createController(document.body.createDiv(), input, [delayed]);

    input.value = '@a';
    input.selectionStart = input.selectionEnd = 2;
    controller.handleInputChange();
    const firstSignal = (delayed.load as Mock).mock.calls[0][1] as AbortSignal;
    input.value = '@b';
    input.selectionStart = input.selectionEnd = 2;
    controller.handleInputChange();
    expect(firstSignal.aborted).toBe(true);
    await screen.findByRole('option', { name: '@new' });
    resolveFirst([{ id: 'old', kind: 'value', label: '@old', replacement: '@old ' }]);
    await first;

    controller.handleKeydown(key('Enter'));
    expect(input.value).toBe('@new ');
  });

  it('destroy is idempotent and fences later results', async () => {
    const input = createInput();
    let resolve!: (items: readonly ComposerDropdownItem[]) => void;
    const pending = new Promise<readonly ComposerDropdownItem[]>(done => { resolve = done; });
    const delayed = source('/', []);
    (delayed.load as Mock).mockReturnValue(pending);
    const controller = createController(document.body.createDiv(), input, [delayed]);

    input.value = '/';
    input.selectionStart = input.selectionEnd = 1;
    controller.handleInputChange();
    controller.destroy();
    controller.destroy();
    resolve([{ id: 'late', kind: 'value', label: '/late', replacement: '/late ' }]);
    await pending;

    expect(controller.isVisible()).toBe(false);
  });
});
