/** @vitest-environment jsdom */
import '@test/helpers/ObsidianSettingsDOM';

import { axe } from '@test/helpers/accessibility';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';
import type { TFile } from 'obsidian';
import { setIcon } from 'obsidian';

import { ComposerDropdownController } from '@/shared/composer-dropdown/ComposerDropdownController';
import { MentionSource } from '@/shared/composer-dropdown/MentionSource';

// jsdom has no layout or scrolling.
Element.prototype.scrollIntoView = vi.fn();
HTMLElement.prototype.setCssProps = function (props) {
  for (const [name, value] of Object.entries(props)) this.style.setProperty(name, value);
};

function file(path: string, minutesAgo: number): TFile {
  const mtime = testDate({ minutes: -minutesAgo }).getTime();
  return { name: path.split('/').pop() ?? path, path, stat: { ctime: mtime, mtime, size: 1 } } as TFile;
}

it('shows vault mentions on the keystroke that requests them and updates the rendered rows in place', async () => {
  const container = document.body.createDiv();
  const input = container.createEl('textarea', { attr: { 'aria-label': 'Message' } });
  const mention = new MentionSource({
    getCachedVaultFiles: () => [file('Alpha one.md', 1), file('Alpha two.md', 2), file('Gamma.md', 3)],
    getCachedVaultFolders: () => [],
  });
  const controller = new ComposerDropdownController(container, input, [mention]);
  const type = (value: string): void => {
    input.value = value;
    input.selectionStart = input.selectionEnd = value.length;
    controller.handleInputChange();
  };
  const ui = within(container);
  const options = (): HTMLElement[] => within(ui.getByRole('listbox', { name: 'Input suggestions' }))
    .getAllByRole('option');
  try {
    type('@');
    expect(options().map(option => option.textContent)).toEqual(['Alpha one.md', 'Alpha two.md', 'Gamma.md']);
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[0].id);
    expect(await axe(container)).toHaveNoViolations();

    const firstRow = options()[0];
    const iconCalls = vi.mocked(setIcon).mock.calls.length;
    type('@Alpha t');
    expect(options().map(option => option.textContent)).toEqual(['Alpha two.md']);
    // Narrowing a query rewrites existing rows instead of rebuilding them and their icons.
    expect(options()[0]).toBe(firstRow);
    expect(vi.mocked(setIcon).mock.calls.length).toBe(iconCalls);
    expect(options()[0].getAttribute('aria-selected')).toBe('true');

    type('@missing');
    expect(options().map(option => [option.textContent, option.getAttribute('aria-disabled')]))
      .toEqual([['No matches', 'true']]);
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);

    type('@Gam');
    const gamma = ui.getByRole('option', { name: 'Gamma.md' });
    expect(gamma.hasAttribute('aria-disabled')).toBe(false);
    expect(input.getAttribute('aria-activedescendant')).toBe(gamma.id);
    gamma.click();
    expect(input.value).toBe('@Gamma.md ');
  } finally {
    controller.destroy();
    mention.destroy();
    container.remove();
  }
});

it('repositions fixed suggestions from their own window and releases that listener on destroy', () => {
  const frame = document.body.createEl('iframe', { attr: { title: 'Popout fixture' } });
  const owner = frame.contentWindow!;
  const container = frame.contentDocument!.createElement('div');
  frame.contentDocument!.body.appendChild(container);
  // Obsidian supplies this element helper in each window.
  container.createDiv = HTMLElement.prototype.createDiv;
  const input = frame.contentDocument!.createElement('textarea');
  input.setAttribute('aria-label', 'Message');
  container.appendChild(input);
  const mention = new MentionSource({ getCachedVaultFiles: () => [file('Alpha.md', 1)], getCachedVaultFolders: () => [] });
  const controller = new ComposerDropdownController(container, input, [mention], { fixed: true });
  let top = 250;
  const measure = vi.spyOn(input, 'getBoundingClientRect').mockImplementation(() => ({
    top, left: 20, width: 300, height: 28, right: 320, bottom: top + 28,
  } as DOMRect));
  try {
    input.value = '@Al';
    controller.handleInputChange();
    const list = within(container).getByRole('listbox', { name: 'Input suggestions' });
    expect(within(list).getByRole('option', { name: 'Alpha.md' })).toBeDefined();
    measure.mockClear();
    top = 100;
    fireEvent.resize(window);
    expect(measure).not.toHaveBeenCalled();
    fireEvent.resize(owner);
    expect(list.style.getPropertyValue('--claudian-fixed-dropdown-bottom')).toBe(`${owner.innerHeight - top + 4}px`);
    controller.destroy();
    measure.mockClear();
    fireEvent.resize(owner);
    expect(measure).not.toHaveBeenCalled();
  } finally {
    controller.destroy();
    mention.destroy();
    frame.remove();
  }
});
it.each(['\nNext paragraph', '\n\nNext paragraph', ' next words'])(
  'preserves the prompt suffix %j when completing a mention immediately before it', async suffix => {
    const container = document.body.createDiv();
    const input = container.createEl('textarea', { attr: { 'aria-label': 'Message' } });
    const mention = new MentionSource({ getCachedVaultFiles: () => [file('Alpha.md', 1)], getCachedVaultFolders: () => [] });
    const controller = new ComposerDropdownController(container, input, [mention]);
    input.value = `@Al${suffix}`;
    input.setSelectionRange(3, 3);
    controller.handleInputChange();
    try {
      const option = within(container).getByRole('option', { name: 'Alpha.md' });
      expect(input.getAttribute('aria-activedescendant')).toBe(option.id);
      expect(controller.handleKeydown(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))).toBe(true);
      expect(input.value).toBe(`@Alpha.md ${suffix.startsWith(' ') ? suffix.slice(1) : suffix}`);
      expect(input.selectionStart).toBe('@Alpha.md '.length);
      expect(controller.isVisible()).toBe(false);
      expect(await axe(container)).toHaveNoViolations();
    } finally {
      controller.destroy(); mention.destroy(); container.remove();
    }
  },
);

describe.each([false, true])('local suggestion scrolling (fixed: %s)', fixed => {
  const nativeScroll = Element.prototype.scrollIntoView;
  afterEach(() => { Element.prototype.scrollIntoView = nativeScroll; });

  function render() {
    const workspace = document.body.createDiv();
    workspace.scrollTop = 120;
    const container = workspace.createDiv();
    const input = container.createEl('textarea', { attr: { 'aria-label': 'Message' } });
    input.getBoundingClientRect = () => new DOMRect(0, 154, 300, 40);
    const mention = new MentionSource({
      getCachedVaultFiles: () => [file('Alpha.md', 1), file('Beta.md', 2), file('Gamma.md', 3)],
      getCachedVaultFolders: () => [],
    });
    const controller = new ComposerDropdownController(container, input, [mention], { fixed });
    input.value = '@';
    input.selectionStart = input.selectionEnd = 1;
    controller.handleInputChange();
    const list = within(container).getByRole('listbox', { name: 'Input suggestions' });
    const options = within(list).getAllByRole('option');
    // Layout/scrolling are external browser ports: a two-row popup overlaps the workspace's top edge.
    const popupTop = () => 50 + (fixed ? 0 : 120 - workspace.scrollTop);
    list.getBoundingClientRect = () => new DOMRect(0, popupTop(), 300, 100);
    workspace.getBoundingClientRect = () => new DOMRect(0, 100, 300, 150);
    options.forEach((option, index) => {
      option.getBoundingClientRect = () => new DOMRect(0, popupTop() + index * 50 - list.scrollTop, 300, 50);
    });
    const reveal = (item: Element, scrollingBox: HTMLElement) => {
      const target = item.getBoundingClientRect();
      const box = scrollingBox.getBoundingClientRect();
      if (target.top < box.top) scrollingBox.scrollTop += target.top - box.top;
      else if (target.bottom > box.bottom) scrollingBox.scrollTop += target.bottom - box.bottom;
    };
    // Native scrollIntoView walks every ancestor, unlike the popup's local reveal policy.
    Element.prototype.scrollIntoView = function () { reveal(this, list); reveal(this, workspace); };
    const dispose = () => { controller.destroy(); mention.destroy(); workspace.remove(); };
    return { workspace, container, input, controller, list, options, dispose };
  }

  it('keeps keyboard selections visible without moving the workspace', async () => {
    const h = render();
    try {
      const key = (key: string) => h.controller.handleKeydown(new KeyboardEvent('keydown', { key }));
      key('ArrowDown');
      expect(h.list.scrollTop).toBe(0);
      key('ArrowDown');
      expect(h.list.scrollTop).toBe(50);
      expect(h.input.getAttribute('aria-activedescendant')).toBe(h.options[2].id);
      key('ArrowUp');
      key('ArrowUp');
      expect(h.list.scrollTop).toBe(0);
      expect(h.workspace.scrollTop).toBe(120);
      expect((await axe(h.container)).violations).toEqual([]);
      key('Enter');
      expect(h.input.value).toBe('@Alpha.md ');
    } finally { h.dispose(); }
  });

  it('selects a hovered edge row without moving either scroller', () => {
    const h = render();
    try {
      fireEvent.mouseEnter(h.options[2]);
      expect(h.options[2].getAttribute('aria-selected')).toBe('true');
      expect(h.input.getAttribute('aria-activedescendant')).toBe(h.options[2].id);
      expect(h.list.scrollTop).toBe(0);
      expect(h.workspace.scrollTop).toBe(120);
      fireEvent.click(h.options[2]);
      expect(h.input.value).toBe('@Gamma.md ');
    } finally { h.dispose(); }
  });
});
