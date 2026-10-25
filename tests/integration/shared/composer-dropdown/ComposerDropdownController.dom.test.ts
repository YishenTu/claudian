/** @jest-environment jsdom */
import '@test/helpers/ObsidianSettingsDOM';

import { testDate } from '@test/helpers/testClock';
import { within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import type { TFile } from 'obsidian';
import { setIcon } from 'obsidian';

import { ComposerDropdownController } from '@/shared/composer-dropdown/ComposerDropdownController';
import { MentionSource } from '@/shared/composer-dropdown/MentionSource';

// jsdom has no layout or scrolling.
Element.prototype.scrollIntoView = jest.fn();

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
    const iconCalls = jest.mocked(setIcon).mock.calls.length;
    type('@Alpha t');
    expect(options().map(option => option.textContent)).toEqual(['Alpha two.md']);
    // Narrowing a query rewrites existing rows instead of rebuilding them and their icons.
    expect(options()[0]).toBe(firstRow);
    expect(jest.mocked(setIcon).mock.calls.length).toBe(iconCalls);
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
