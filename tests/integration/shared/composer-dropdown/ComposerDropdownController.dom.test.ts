// @test-ci {"inputs":["src/style/components/composer-dropdown.css"]}
/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { axe } from '@test/helpers/accessibility';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';
import type { TFile } from 'obsidian';
import { setIcon } from 'obsidian';

import { ProviderCommandDiscoveryStore } from '@/core/providers/commands/ProviderCommandDiscoveryStore';
import { GrokCommandCatalog } from '@/providers/grok/commands/GrokCommandCatalog';
import { normalizeGrokCommands } from '@/providers/grok/normalization/grokCommandNormalization';
import { ComposerDropdownController } from '@/shared/composer-dropdown/ComposerDropdownController';
import { MentionSource } from '@/shared/composer-dropdown/MentionSource';
import { SlashCommandSource } from '@/shared/composer-dropdown/SlashCommandSource';

// jsdom has no layout or scrolling.
Element.prototype.scrollIntoView = vi.fn();

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
    // Obsidian renders any aria-label as a hover tooltip over the whole menu.
    expect(ui.getByRole('listbox', { name: 'Input suggestions' }).hasAttribute('aria-label')).toBe(false);

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

// Browser layout is external to jsdom. These ports resolve the shipped CSS anchors/cap;
// they never choose a side or decide whether content fits.
function fixedLayout(top: number, viewport: number, count: number) {
  const style = document.head.createEl('style');
  style.textContent = readFileSync(path.resolve('src/style/components/composer-dropdown.css'), 'utf8');
  const rules = [...style.sheet!.cssRules] as CSSStyleRule[];
  const base = rules.find(rule => rule.selectorText === '.claudian-composer-dropdown')!.style;
  const fixed = rules.find(rule => rule.selectorText === '.claudian-composer-dropdown--fixed')!.style;
  const originalHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')!;
  const setViewport = (height: number) => Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
  setViewport(viewport);
  const workspace = document.body.createDiv();
  workspace.scrollTop = 120;
  const container = workspace.createDiv();
  const input = container.createEl('textarea', { attr: { 'aria-label': 'Message' } });
  const measure = vi.spyOn(input, 'getBoundingClientRect').mockImplementation(() => new DOMRect(20, top, 260, 32));
  const mention = new MentionSource({
    getCachedVaultFiles: () => Array.from({ length: count }, (_, index) => file(`Note${String(index + 1).padStart(2, '0')}.md`, index)),
    getCachedVaultFolders: () => [],
  });
  const controller = new ComposerDropdownController(container, input, [mention], { fixed: true });
  input.value = '@'; input.setSelectionRange(1, 1); controller.handleInputChange();
  const list = within(container).getByRole('listbox', { name: 'Input suggestions' });
  const options = within(list).getAllByRole('option');
  // Discover actual owned nodes, then reopen through the first-visible branch with layout ports attached.
  controller.hide();
  const declared = (property: string) => (fixed.getPropertyValue(property) || base.getPropertyValue(property))
    .replace(/var\((--[\w-]+)\)/g, (_match, variable: string) => list.style.getPropertyValue(variable));
  // Obsidian's native box sizing includes the border in max-height (baseline outer cap: 300px).
  const outerHeight = () => Math.min(count * 34 + 2, parseFloat(declared('max-height')));
  const rectangle = () => {
    const anchor = declared('top');
    const y = anchor && anchor !== 'auto' ? parseFloat(anchor)
      : window.innerHeight - parseFloat(declared('bottom')) - outerHeight() - (parseFloat(declared('margin-bottom')) || 0);
    return new DOMRect(parseFloat(declared('left')), y, parseFloat(declared('width')), outerHeight());
  };
  vi.spyOn(list, 'getBoundingClientRect').mockImplementation(rectangle);
  Object.defineProperties(list, {
    scrollHeight: { configurable: true, get: () => count * 34 },
    offsetHeight: { configurable: true, get: outerHeight },
    clientHeight: { configurable: true, get: () => Math.max(0, outerHeight() - 2) },
  });
  options.forEach((option, index) => vi.spyOn(option, 'getBoundingClientRect').mockImplementation(() =>
    new DOMRect(rectangle().left + 1, rectangle().top + 1 + index * 34 - list.scrollTop, 278, 34)));
  controller.handleInputChange();
  return { workspace, input, list, options, controller, measure,
    key: (key: string) => controller.handleKeydown(new KeyboardEvent('keydown', { key, cancelable: true })),
    position(nextTop: number, height: number) { top = nextTop; setViewport(height); },
    dispose() { controller.destroy(); mention.destroy(); workspace.remove(); style.remove(); Object.defineProperty(window, 'innerHeight', originalHeight); },
  };
}

it.each([
  { label: 'near-top input', top: 161, viewport: 800, count: 12, y: 201, height: 300, cap: 300, above: false },
  { label: 'enough space above', top: 600, viewport: 800, count: 12, y: 292, height: 300, cap: 300, above: true },
  { label: 'short natural list', top: 100, viewport: 800, count: 2, y: 22, height: 70, cap: 92, above: true },
  { label: 'larger space below', top: 180, viewport: 400, count: 12, y: 220, height: 180, cap: 180, above: false },
  { label: 'larger space above', top: 220, viewport: 400, count: 12, y: 0, height: 212, cap: 212, above: true },
])('fits fixed suggestions with $label and preserves keyboard replacement', ({ top, viewport, count, y, height, cap, above }) => {
  const h = fixedLayout(top, viewport, count);
  try {
    const rect = h.list.getBoundingClientRect();
    expect({ top: rect.top, height: rect.height, left: rect.left, width: rect.width }).toEqual({ top: y, height, left: 20, width: 280 });
    expect(h.list.style.getPropertyValue('--claudian-fixed-dropdown-max-height')).toBe(`${cap}px`);
    expect(h.list.style.getPropertyValue(above ? '--claudian-fixed-dropdown-top' : '--claudian-fixed-dropdown-bottom')).toBe('auto');
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(viewport);
    for (let index = 1; index < count; index++) h.key('ArrowDown');
    const selected = h.options[count - 1];
    expect(h.input.getAttribute('aria-activedescendant')).toBe(selected.id);
    expect(selected.getBoundingClientRect().top).toBeGreaterThanOrEqual(rect.top);
    expect(selected.getBoundingClientRect().bottom).toBeLessThanOrEqual(rect.bottom);
    expect(h.workspace.scrollTop).toBe(120);
    expect(h.key('Enter')).toBe(true);
    expect(h.input.value).toBe(count === 2 ? '@Note02.md ' : '@Note12.md ');
  } finally { h.dispose(); }
});

it('reprojects and reveals the selected row after caps change, leaving internal scroll alone', () => {
  const h = fixedLayout(600, 800, 12);
  try {
    for (let index = 1; index < 12; index++) h.key('ArrowDown');
    const selected = h.options[11];
    const active = h.input.getAttribute('aria-activedescendant');
    h.list.scrollTop = 50;
    h.position(550, 800); fireEvent.scroll(h.workspace, { bubbles: false });
    expect(h.list.getBoundingClientRect().height).toBe(300);
    expect(h.list.scrollTop).toBe(50);
    h.position(180, 400); fireEvent.resize(window);
    expect(h.list.getBoundingClientRect().top).toBe(220);
    expect(h.list.getBoundingClientRect().height).toBe(180);
    expect(h.list.scrollTop).toBe(229);
    expect(selected.getBoundingClientRect().bottom).toBe(400);
    h.measure.mockClear(); h.list.scrollTop = 50;
    fireEvent.scroll(h.list); fireEvent.scroll(selected);
    expect(h.measure).not.toHaveBeenCalled();
    expect(h.list.scrollTop).toBe(50);
    h.position(100, 400); fireEvent.scroll(h.workspace, { bubbles: false });
    expect(h.measure).toHaveBeenCalled();
    expect(h.list.getBoundingClientRect().top).toBe(140);
    expect(h.list.getBoundingClientRect().height).toBe(260);
    expect(selected.getBoundingClientRect().bottom).toBe(400);
    h.position(600, 800); fireEvent.resize(window);
    expect(h.list.getBoundingClientRect().top).toBe(292);
    expect(h.list.getBoundingClientRect().height).toBe(300);
    expect(h.input.getAttribute('aria-activedescendant')).toBe(active);
    expect(within(h.list).getAllByRole('option')[11]).toBe(selected);
    expect(h.workspace.scrollTop).toBe(120);
    h.controller.hide(); h.measure.mockClear();
    fireEvent.resize(window); fireEvent.scroll(h.workspace, { bubbles: false });
    expect(h.measure).not.toHaveBeenCalled();
    h.controller.handleInputChange();
    expect(h.measure).toHaveBeenCalled();
  } finally { h.dispose(); }
});

it('repositions fixed suggestions from their own window and releases that listener on destroy', () => {
  const frame = document.body.createEl('iframe', { attr: { title: 'Popout fixture' } });
  const owner = frame.contentWindow!;
  const container = frame.contentDocument!.createElement('div');
  frame.contentDocument!.body.appendChild(container);
  // Obsidian supplies this element helper in each window.
  container.createDiv = HTMLElement.prototype.createDiv;
  container.createSpan = HTMLElement.prototype.createSpan;
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
    expect(list.style.getPropertyValue('--claudian-fixed-dropdown-bottom')).toBe(`${owner.innerHeight - top + 8}px`);
    measure.mockClear();
    fireEvent.scroll(container, { bubbles: false });
    expect(measure).toHaveBeenCalled();
    measure.mockClear(); list.scrollTop = 25;
    fireEvent.scroll(list);
    expect(measure).not.toHaveBeenCalled();
    expect(list.scrollTop).toBe(25);
    controller.hide(); measure.mockClear();
    fireEvent.resize(owner); fireEvent.scroll(container, { bubbles: false });
    expect(measure).not.toHaveBeenCalled();
    controller.handleInputChange();
    expect(within(container).getByRole('listbox', { name: 'Input suggestions' })).toBe(list);
    expect(measure).toHaveBeenCalled();
    controller.destroy();
    measure.mockClear();
    fireEvent.resize(owner); fireEvent.scroll(container, { bubbles: false });
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

it('marks the typed text in slash command names and shows the alias a query matched', () => {
  const container = document.body.createDiv();
  const input = container.createEl('textarea', { attr: { 'aria-label': 'Message' } });
  const slash = new SlashCommandSource();
  const controller = new ComposerDropdownController(container, input, [slash]);
  const type = (value: string): void => {
    input.value = value;
    input.selectionStart = input.selectionEnd = value.length;
    controller.handleInputChange();
  };
  const list = (): HTMLElement => within(container).getByRole('listbox', { name: 'Input suggestions' });
  const option = (name: string): HTMLElement => within(list()).getByRole('option', { name: new RegExp(`^${name} `) });
  const marked = (row: HTMLElement): Array<string | null> => [...row.querySelectorAll('.claudian-composer-dropdown-match')]
    .map(mark => mark.textContent);
  try {
    type('/ID');
    const side = option('/side');
    expect(marked(side)).toEqual(['id']);

    type('/bt');
    const viaAlias = option('/side \\(btw\\)');
    expect(within(list()).getAllByRole('option')[0]).toBe(viaAlias);
    expect(marked(viaAlias)).toEqual(['bt']);

    type('/');
    expect(marked(list())).toEqual([]);
    expect(marked(option('/side'))).toEqual([]);
  } finally {
    controller.destroy();
    slash.destroy();
    container.remove();
  }
});

it.each([
  ['İstanbul', 'stanbul', 2, 9, 'stanbul'],
  ['preİpost', 'İp', 4, 6, 'İp'],
  ['İΟΣ', 'ος', 2, 4, 'ΟΣ'],
  ['𐐀İstanbul', 'stanbul', 4, 11, 'stanbul'],
])('marks original native command %s for query %s', async (name, query, start, end, expected) => {
  const catalog = new GrokCommandCatalog();
  const discovery = new ProviderCommandDiscoveryStore(async () => {
    const items = await catalog.listDropdownEntries({
      includeBuiltIns: false,
      commandSnapshot: normalizeGrokCommands([{ name, description: 'Native command' }]),
    });
    if (!items.length) throw new Error('Expected a native command');
    return { status: 'ready', items: [items[0], ...items.slice(1)] };
  });
  await discovery.load();
  const slash = new SlashCommandSource({
    includeBuiltIns: false,
    providerConfig: catalog.getDropdownConfig(),
    providerDiscovery: discovery,
  });
  const container = document.body.createDiv();
  const input = container.createEl('textarea', { attr: { 'aria-label': 'Message' } });
  const controller = new ComposerDropdownController(container, input, [slash]);
  try {
    input.value = `/${query}`;
    input.selectionStart = input.selectionEnd = input.value.length;
    controller.handleInputChange();
    const row = within(container).getByRole('option', { name: `/${name} Native command` });
    expect([...row.querySelectorAll('.claudian-composer-dropdown-match')].map(mark => mark.textContent))
      .toEqual([expected]);
    const trigger = slash.match(input.value, input.value.length)!;
    expect(slash.load(trigger, new AbortController().signal)[0]).toMatchObject({
      label: `/${name}`,
      labelMatch: { start, end },
    });
    expect(await axe(container)).toHaveNoViolations();
    expect(controller.handleKeydown(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))).toBe(true);
    expect(input.value).toBe(`/${name} `);
  } finally {
    controller.destroy();
    slash.destroy();
    discovery.dispose();
    container.remove();
  }
});
