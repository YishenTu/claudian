import { createMockEl } from '@test/helpers/MockElement';

import { ComposerDropdownController } from '@/shared/composer-dropdown/ComposerDropdownController';
import type {
  ComposerDropdownItem,
  ComposerDropdownSource,
  ComposerTriggerMatch,
} from '@/shared/composer-dropdown/types';

function createInput(): HTMLTextAreaElement {
  return {
    value: '',
    selectionStart: 0,
    selectionEnd: 0,
    focus: jest.fn(),
    setAttribute: jest.fn(),
    removeAttribute: jest.fn(),
    getBoundingClientRect: jest.fn().mockReturnValue({ top: 0, left: 0, width: 300 }),
    ownerDocument: { defaultView: { innerHeight: 800 } },
  } as unknown as HTMLTextAreaElement;
}

function key(key: string): KeyboardEvent {
  return {
    isComposing: false,
    key,
    preventDefault: jest.fn(),
  } as unknown as KeyboardEvent;
}

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
    load: jest.fn().mockResolvedValue(items),
    select: item => item.kind === 'value'
      ? { kind: 'replace', text: item.replacement }
      : { kind: 'none' },
  };
}

describe('ComposerDropdownController', () => {
  it('arbitrates sources and replaces only the active token', async () => {
    const input = createInput();
    const controller = new ComposerDropdownController(
      createMockEl(),
      input,
      [
        source('/', [{ id: 'slash', kind: 'value', label: '/clear', replacement: '/clear ' }]),
        source('#', [{ id: 'ticket', kind: 'value', label: '#3', replacement: '#3 ' }]),
      ],
    );

    input.value = 'Review #3 later';
    input.selectionStart = input.selectionEnd = 9;
    controller.handleInputChange();
    await Promise.resolve();

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
    const controller = new ComposerDropdownController(createMockEl(), input, [mention, ticket]);

    input.value = 'Review @notes/spec.md then #1';
    input.selectionStart = input.selectionEnd = input.value.length;
    controller.handleInputChange();
    await Promise.resolve();
    controller.handleKeydown(key('Enter'));

    expect(input.value).toBe('Review @notes/spec.md then #12 ');
    controller.destroy();
  });

  it('preserves provider-owned trigger characters', async () => {
    const input = createInput();
    const dollar = source('$', [
      { id: 'skill', kind: 'value', label: '$review', replacement: '$review ' },
    ]);
    const controller = new ComposerDropdownController(createMockEl(), input, [dollar]);

    input.value = '$rev';
    input.selectionStart = input.selectionEnd = 4;
    controller.handleInputChange();
    await Promise.resolve();

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
    const controller = new ComposerDropdownController(createMockEl(), input, [providerSource]);

    input.value = '$rev';
    input.selectionStart = input.selectionEnd = 4;
    controller.handleInputChange();
    await Promise.resolve();
    expect(controller.isVisible()).toBe(true);

    trigger = '/';
    invalidate();
    await Promise.resolve();

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
    (delayed.load as jest.Mock)
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce([
        { id: 'new', kind: 'value', label: '@new', replacement: '@new ' },
      ]);
    const controller = new ComposerDropdownController(createMockEl(), input, [delayed]);

    input.value = '@a';
    input.selectionStart = input.selectionEnd = 2;
    controller.handleInputChange();
    input.value = '@b';
    input.selectionStart = input.selectionEnd = 2;
    controller.handleInputChange();
    await Promise.resolve();
    resolveFirst([{ id: 'old', kind: 'value', label: '@old', replacement: '@old ' }]);
    await Promise.resolve();

    controller.handleKeydown(key('Enter'));
    expect(input.value).toBe('@new ');
  });

  it('opens a folder and Escape returns to the root menu', async () => {
    const input = createInput();
    const containerEl = createMockEl();
    const folderItems: readonly ComposerDropdownItem[] = [
      { id: 'alice', kind: 'value', label: 'Alice', replacement: "@Alice's Changes " },
    ];
    const mention = source('@', [{
      id: 'members',
      kind: 'folder',
      label: "Member's Changes",
      load: jest.fn().mockResolvedValue(folderItems),
    }]);
    const controller = new ComposerDropdownController(containerEl, input, [mention]);

    input.value = '@';
    input.selectionStart = input.selectionEnd = 1;
    controller.handleInputChange();
    await Promise.resolve();
    controller.handleKeydown(key('Enter'));
    await Promise.resolve();

    const labels = () => containerEl
      .querySelectorAll('.claudian-composer-dropdown-label')
      .map((el: { textContent: string }) => el.textContent);
    expect(labels()).toEqual(['Alice']);
    controller.handleKeydown(key('Escape'));
    await Promise.resolve();
    expect(labels()).toEqual(["Member's Changes"]);
    expect(controller.isVisible()).toBe(true);
  });

  it('keeps a folder active while typing through a prefix containing spaces', async () => {
    const input = createInput();
    const loadFolder = jest.fn().mockResolvedValue([
      { id: 'alice', kind: 'value', label: 'Alice', replacement: "@Alice's Changes " },
    ]);
    const mention = source('@', [{
      id: 'members',
      inputPrefix: "Member's Changes/",
      kind: 'folder',
      label: "Member's Changes",
      load: loadFolder,
    }]);
    const controller = new ComposerDropdownController(createMockEl(), input, [mention]);
    input.value = '@';
    input.selectionStart = input.selectionEnd = 1;
    controller.handleInputChange();
    await Promise.resolve();
    controller.handleKeydown(key('Enter'));
    await Promise.resolve();

    input.value += 'ali';
    input.selectionStart = input.selectionEnd = input.value.length;
    controller.handleInputChange();
    await Promise.resolve();

    expect(loadFolder).toHaveBeenLastCalledWith('ali', expect.any(AbortSignal));
    expect(controller.isVisible()).toBe(true);
    controller.destroy();
  });

  it('destroy is idempotent and fences later results', async () => {
    const input = createInput();
    let resolve!: (items: readonly ComposerDropdownItem[]) => void;
    const pending = new Promise<readonly ComposerDropdownItem[]>(done => { resolve = done; });
    const delayed = source('/', []);
    (delayed.load as jest.Mock).mockReturnValue(pending);
    const controller = new ComposerDropdownController(createMockEl(), input, [delayed]);

    input.value = '/';
    input.selectionStart = input.selectionEnd = 1;
    controller.handleInputChange();
    controller.destroy();
    controller.destroy();
    resolve([{ id: 'late', kind: 'value', label: '/late', replacement: '/late ' }]);
    await Promise.resolve();

    expect(controller.isVisible()).toBe(false);
  });
});
