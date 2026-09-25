/** @jest-environment jsdom */

import { fireEvent, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import { TFolder } from 'obsidian';

import { LinkedContentController } from '@/features/chat/linked-content/LinkedContentController';
import { createWelcomeElement } from '@/features/chat/rendering/WelcomeRenderer';

beforeAll(() => {
  Object.assign(HTMLElement.prototype, {
    empty(this: HTMLElement) { this.replaceChildren(); },
    addClass(this: HTMLElement, ...names: string[]) { this.classList.add(...names); },
    removeClass(this: HTMLElement, ...names: string[]) { this.classList.remove(...names); },
    toggleClass(this: HTMLElement, name: string, force: boolean) { this.classList.toggle(name, force); },
    scrollIntoView() {},
  });
});

it('navigates linked-content choices with arrows, selects, and returns focus on Escape', async () => {
  const folders = ['Plans', 'Projects'].map(path => Object.assign(new TFolder(), { name: path, path }));
  const controller = new LinkedContentController({
    app: {
      vault: { getAbstractFileByPath: (path: string) => folders.find(folder => folder.path === path) ?? null },
      workspace: { getActiveFile: () => null },
    } as never,
    getExcludedTags: () => [],
    getCachedVaultFiles: () => [],
    getCachedVaultFolders: () => folders,
  });
  const container = document.body.createDiv();
  const welcome = createWelcomeElement(container, 'Hello');
  const view = within(welcome);

  try {
    controller.mountWelcome(welcome);
    const selector = view.getByRole('button', { name: 'None' });
    fireEvent.click(selector);
    const search = view.getByRole('textbox', { name: 'Linked content:' });
    expect(document.activeElement).toBe(search);
    fireEvent.input(search, { target: { value: 'p' } });

    expect(view.getByRole('listbox', { name: 'Linked content choices' })).toBeTruthy();
    expect(view.getAllByRole('option')).toHaveLength(2);
    expect(view.getByRole('option', { name: 'Plans. Plans' }).getAttribute('aria-selected')).toBe('true');
    expect(view.getByRole('option', { name: 'Projects. Projects' }).getAttribute('aria-selected')).toBe('false');
    expect(await axe(welcome, {
      runOnly: ['label', 'aria-valid-attr-value', 'aria-roles', 'aria-required-parent', 'aria-required-children'],
    })).toHaveNoViolations();

    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(view.getByRole('option', { name: 'Projects. Projects' }).getAttribute('aria-selected')).toBe('true');
    expect(view.getByRole('option', { name: 'Plans. Plans' }).getAttribute('aria-selected')).toBe('false');
    fireEvent.keyDown(search, { key: 'ArrowUp' });
    expect(view.getByRole('option', { name: 'Plans. Plans' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(controller.getSnapshot()).toEqual({ mode: 'explicit-draft', path: 'Projects' });
    expect(view.queryByRole('textbox')).toBeNull();
    expect(view.queryByRole('listbox')).toBeNull();
    expect(selector.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(selector);

    fireEvent.click(view.getByRole('button', { name: 'Projects' }));
    fireEvent.keyDown(view.getByRole('textbox', { name: 'Linked content:' }), { key: 'Escape' });
    expect(view.queryByRole('textbox')).toBeNull();
    expect(selector.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(selector);

    fireEvent.click(selector);
    expect(view.getByRole('textbox', { name: 'Linked content:' })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(view.queryByRole('textbox')).toBeNull();
    expect(selector.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(selector);
  } finally {
    controller.destroy();
    container.remove();
  }
});
