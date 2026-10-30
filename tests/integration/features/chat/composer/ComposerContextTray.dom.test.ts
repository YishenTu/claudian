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
  Object.assign(HTMLElement.prototype, {
    empty(this: HTMLElement) { this.replaceChildren(); },
    addClass(this: HTMLElement, ...names: string[]) { this.classList.add(...names); },
    removeClass(this: HTMLElement, ...names: string[]) { this.classList.remove(...names); },
    toggleClass(this: HTMLElement, name: string, force: boolean) { this.classList.toggle(name, force); },
  });
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
