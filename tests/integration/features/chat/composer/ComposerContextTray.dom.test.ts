/** @vitest-environment jsdom */

import { axe } from '@test/helpers/accessibility';
import { fireEvent, within } from '@testing-library/dom';

import { ComposerContextTray } from '@/features/chat/composer/ComposerContextTray';

let tray: ComposerContextTray;
let host: HTMLElement;
let visibility: HTMLStyleElement;

beforeEach(() => {
  document.body.replaceChildren();
  // Supply the host's class-based visibility contract; jsdom does not load plugin CSS.
  visibility = document.head.appendChild(document.createElement('style'));
  visibility.textContent = '.claudian-hidden, .claudian-context-chip--overflow-hidden { display: none; }';
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function (this: HTMLElement) { return this.parentElement; });
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
    return this.dataset.contextId === 'second' ? 40 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(24);
  host = document.body.createDiv();
  tray = new ComposerContextTray(host);
});

afterEach(() => {
  tray.destroy();
  visibility.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('moves focus to the next remaining remove action after an image is removed', async () => {
  const second = { id: 'second', kind: 'image' as const, label: 'Second image', onRemove: vi.fn() };
  tray.setItems('images', [{
    id: 'first', kind: 'image', label: 'First image',
    onRemove: () => tray.setItems('images', [second]),
  }, second]);
  const remove = within(host).getByRole('button', { name: 'Remove First image' });
  remove.focus();
  fireEvent.click(remove);
  const remaining = within(host).getByRole('button', { name: 'Remove Second image' });
  expect(document.activeElement).toBe(remaining);
  expect(remaining.closest('.claudian-context-chip--overflow-hidden')).toBeNull();
  expect(await axe(host)).toHaveNoViolations();
});

it('keeps focus on the same selection action when a different context slot changes', () => {
  tray.setItems('editor-selection', [{ id: 'editor', kind: 'selection', label: 'Editor selection', onActivate: vi.fn() }]);
  within(host).getByRole('button', { name: 'Editor selection' }).focus();
  tray.setItems('images', [{ id: 'first', kind: 'image', label: 'Image', onRemove: vi.fn() }]);
  expect(document.activeElement).toBe(within(host).getByRole('button', { name: 'Editor selection' }));
});

it('keeps remaining overflow collapsed when the restored action is already in its visible row', () => {
  const remaining = [
    { id: 'same-row', kind: 'image' as const, label: 'Visible image', onRemove: vi.fn() },
    { id: 'second', kind: 'image' as const, label: 'Overflow image', onRemove: vi.fn() },
  ];
  tray.setItems('images', [{
    id: 'first', kind: 'image', label: 'Removed image',
    onRemove: () => tray.setItems('images', remaining),
  }, ...remaining]);
  tray.refreshLayout();
  const remove = within(host).getByRole('button', { name: 'Remove Removed image' });
  remove.focus();
  fireEvent.click(remove);
  expect(document.activeElement).toBe(within(host).getByRole('button', { name: 'Remove Visible image' }));
  expect(within(host).getByRole('button', { name: 'Show 1 more context items' }).getAttribute('aria-expanded')).toBe('false');
  expect(within(host).queryByRole('button', { name: 'Remove Overflow image' })).toBeNull();
});

it('expands before restoring a focused action that would otherwise be hidden', () => {
  const items = [
    { id: 'first', kind: 'image' as const, label: 'First image', onRemove: vi.fn() },
    { id: 'second', kind: 'image' as const, label: 'Second image', onRemove: vi.fn() },
  ];
  tray.setItems('images', items);
  tray.refreshLayout();
  fireEvent.click(within(host).getByRole('button', { name: 'Show 1 more context items' }));
  within(host).getByRole('button', { name: 'Remove Second image' }).focus();
  tray.setItems('images', items);
  expect(document.activeElement).toBe(within(host).getByRole('button', { name: 'Remove Second image' }));
  expect(document.activeElement?.closest('.claudian-context-chip--overflow-hidden')).toBeNull();
  expect(within(host).getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe('true');
});

it('does not blur a focused overflow control while recomputing its layout', () => {
  tray.setItems('images', [
    { id: 'first', kind: 'image', label: 'First image', onRemove: vi.fn() },
    { id: 'second', kind: 'image', label: 'Second image', onRemove: vi.fn() },
  ]);
  tray.refreshLayout();
  const more = within(host).getByRole('button', { name: 'Show 1 more context items' });
  more.focus();
  const blur = vi.fn();
  more.addEventListener('blur', blur);
  // jsdom omits native display:none focus loss; adapt that host behavior only.
  more.addClass = function (...names) {
    this.classList.add(...names);
    if (names.includes('claudian-hidden') && document.activeElement === this) this.blur();
  };
  tray.refreshLayout();
  expect(document.activeElement).toBe(more);
  expect(blur).not.toHaveBeenCalled();
});

it('keeps activation separate from removal and drops a withdrawn remove action', async () => {
  const onActivate = vi.fn();
  const onRemove = vi.fn();
  const item = {
    id: 'editor', kind: 'selection' as const, label: 'Architecture.md',
    ariaLabel: 'notes/Architecture.md', onActivate,
  };
  tray.setItems('editor-selection', [{ ...item, onRemove }]);
  const activate = within(host).getByRole('button', { name: 'notes/Architecture.md' });
  const remove = within(host).getByRole('button', { name: 'Remove notes/Architecture.md' });
  expect(activate.tagName).toBe('BUTTON');
  expect(remove.tagName).toBe('BUTTON');
  activate.focus();
  expect(document.activeElement).toBe(activate);
  fireEvent.click(activate);
  expect(onActivate).toHaveBeenCalledTimes(1);
  expect(onRemove).not.toHaveBeenCalled();
  remove.focus();
  expect(document.activeElement).toBe(remove);
  fireEvent.click(remove);
  expect(onRemove).toHaveBeenCalledTimes(1);
  expect(onActivate).toHaveBeenCalledTimes(1);
  expect(await axe(host)).toHaveNoViolations();

  tray.setItems('editor-selection', [item]);
  expect(within(host).getByRole('button', { name: 'notes/Architecture.md' })).toBeDefined();
  expect(within(host).queryByRole('button', { name: 'Remove notes/Architecture.md' })).toBeNull();
});

it('releases its observer when construction fails after observation starts', () => {
    const containerEl = document.body.createDiv();
    const disconnect = vi.fn();
    const ResizeObserverConstructor = class {
      observe(): void {}
      disconnect(): void {
        disconnect();
      }
    };
    vi.stubGlobal('ResizeObserver', ResizeObserverConstructor);
    const initializationError = new Error('Context tray render failed');

    expect(() => new ComposerContextTray(
      containerEl,
      { onDidChange: () => { throw initializationError; } },
    )).toThrow(initializationError);

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(containerEl.children).toHaveLength(0);
  });

it('owns empty-state visibility and renders slots in semantic order', () => {
    const containerEl = host;

    expect(containerEl.hasClass('has-content')).toBe(false);
    expect(containerEl.dataset.contextSlots).toBeUndefined();

    tray.setItems('images', [{
      id: 'image-1',
      kind: 'image',
      label: 'Image',
      onRemove: vi.fn(),
    }]);
    tray.setItems('editor-selection', [{
      id: 'editor-selection',
      kind: 'selection',
      label: '3 lines · Draft.md',
      icon: 'text-select',
      onRemove: vi.fn(),
    }]);
    tray.setItems('browser-selection', [{
      id: 'browser-selection',
      kind: 'selection',
      label: 'Selection · example.com',
      icon: 'globe',
      onRemove: vi.fn(),
    }]);

    expect(containerEl.hasClass('has-content')).toBe(true);
    // Presentations can match on which slots are filled without inspecting chips.
    expect(containerEl.dataset.contextSlots).toBe('editor-selection browser-selection images');
    expect(Array.from(containerEl.querySelectorAll<HTMLElement>('.claudian-context-chip')).map((item) => item.dataset.contextSlot)).toEqual([
      'editor-selection',
      'browser-selection',
      'images',
    ]);
  });

it('collapses content after the first visual row and exposes the hidden count', () => {
    const containerEl = host;

    tray.setItems('images', Array.from({ length: 4 }, (_, index) => ({
      id: `image-${index}`,
      kind: 'image' as const,
      label: `image-${index}.png`,
      onRemove: vi.fn(),
    })));

    const chips = Array.from(containerEl.querySelectorAll<HTMLElement>('.claudian-context-chip'));
    [0, 0, 38, 76].forEach((offsetTop, index) => {
      Object.defineProperty(chips[index], 'offsetTop', { configurable: true, value: offsetTop });
    });

    tray.refreshLayout();

    expect(chips[2].hasClass('claudian-context-chip--overflow-hidden')).toBe(true);
    expect(chips[3].hasClass('claudian-context-chip--overflow-hidden')).toBe(true);
    const moreButton = containerEl.querySelector<HTMLButtonElement>('.claudian-context-more');
    expect(moreButton?.textContent).toBe('+2 more');

    moreButton?.click();

    expect(containerEl.hasClass('claudian-context-row--expanded')).toBe(true);
    expect(chips.every((chip) => !chip.hasClass('claudian-context-chip--overflow-hidden'))).toBe(true);
    expect(moreButton?.textContent).toBe('Show less');
  });

it('does not collapse vertically centered items that share one flex row', () => {
    const containerEl = host;

    tray.setItems('browser-selection', [{
      id: 'browser',
      kind: 'selection',
      label: 'Selection · example.com',
      onRemove: vi.fn(),
    }]);
    tray.setItems('editor-selection', [{
      id: 'selection',
      kind: 'selection',
      label: '1 line selected',
      onRemove: vi.fn(),
    }]);
    tray.setItems('images', [{
      id: 'image',
      kind: 'image',
      label: 'Image',
      onRemove: vi.fn(),
    }]);

    const chips = Array.from(containerEl.querySelectorAll<HTMLElement>('.claudian-context-chip'));
    [[4, 24], [0, 32], [4, 24]].forEach(([offsetTop, offsetHeight], index) => {
      Object.defineProperties(chips[index], {
        offsetTop: { configurable: true, value: offsetTop },
        offsetHeight: { configurable: true, value: offsetHeight },
      });
    });

    tray.refreshLayout();

    expect(containerEl.querySelector<HTMLButtonElement>('.claudian-context-more')?.hasClass('claudian-hidden')).toBe(true);
  });

it('measures rows from rendered chips only, ignoring chips a presentation hides', () => {
    const containerEl = host;
    tray.setItems('editor-selection', [{ id: 'selection', kind: 'selection', label: '1 line selected', onRemove: vi.fn() }]);
    tray.setItems('images', Array.from({ length: 3 }, (_, index) => ({
      id: `image-${index}`,
      kind: 'image' as const,
      label: `image-${index}.png`,
      onRemove: vi.fn(),
    })));

    // Hidden elements report no offset parent and a zero position.
    const chips = Array.from(containerEl.querySelectorAll<HTMLElement>('.claudian-context-chip'));
    const layout = (visibleTops: number[]) => [null, ...visibleTops].forEach((offsetTop, index) => {
      Object.defineProperties(chips[index], {
        offsetParent: { configurable: true, value: offsetTop === null ? null : containerEl },
        offsetTop: { configurable: true, value: offsetTop ?? 0 },
        offsetHeight: { configurable: true, value: offsetTop === null ? 0 : 24 },
      });
    });
    const moreButton = containerEl.querySelector<HTMLButtonElement>('.claudian-context-more');

    layout([8, 8, 8]);
    tray.refreshLayout();
    expect(moreButton?.hasClass('claudian-hidden')).toBe(true);

    layout([8, 8, 46]);
    tray.refreshLayout();
    expect(moreButton?.textContent).toBe('+1 more');
    expect(chips[3].hasClass('claudian-context-chip--overflow-hidden')).toBe(true);
    expect(chips[1].hasClass('claudian-context-chip--overflow-hidden')).toBe(false);
  });

it('removes the tray when the final owner clears its items', () => {
    const containerEl = host;

    tray.setItems('canvas-selection', [{
      id: 'canvas-selection',
      kind: 'selection',
      label: '2 nodes · Board.canvas',
      onRemove: vi.fn(),
    }]);
    tray.clearItems('canvas-selection');

    expect(containerEl.hasClass('has-content')).toBe(false);
    expect(containerEl.dataset.contextSlots).toBeUndefined();
    expect(containerEl.children).toHaveLength(0);
  });
