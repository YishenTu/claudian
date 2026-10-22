/** @jest-environment jsdom */

import { fireEvent, within } from '@testing-library/dom';
import { axe } from 'jest-axe';

import { ComposerInfoRow } from '@/features/chat/composer/ComposerInfoRow';

beforeAll(() => {
  Object.assign(HTMLElement.prototype, {
    empty(this: HTMLElement) { this.replaceChildren(); },
    addClass(this: HTMLElement, ...names: string[]) { this.classList.add(...names); },
    removeClass(this: HTMLElement, ...names: string[]) { this.classList.remove(...names); },
    hasClass(this: HTMLElement, name: string) { return this.classList.contains(name); },
    toggleClass(this: HTMLElement, name: string, force: boolean) { this.classList.toggle(name, force); },
  });
});

afterEach(() => {
  document.body.replaceChildren();
});

function mount() {
  const rowEl = document.body.createDiv();
  const row = new ComposerInfoRow(rowEl);
  return { row, rowEl, view: within(rowEl) };
}

it('shows the linked note as an activatable button with a remove control only while removable', async () => {
  const { row, rowEl, view } = mount();
  const onActivate = jest.fn();
  const onRemove = jest.fn();

  row.setLinkedContent({
    label: 'Plan',
    icon: 'file-text',
    ariaLabel: 'Linked content: Notes/Plan.md',
    onActivate,
    onRemove,
  });

  const note = view.getByRole('button', { name: 'Linked content: Notes/Plan.md' });
  expect(note.getAttribute('type')).toBe('button');
  expect(note.textContent).toBe('Plan');
  fireEvent.click(note);
  expect(onActivate).toHaveBeenCalledTimes(1);

  const remove = view.getByRole('button', { name: 'Remove Linked content: Notes/Plan.md' });
  expect(remove.getAttribute('type')).toBe('button');
  fireEvent.click(remove);
  expect(onRemove).toHaveBeenCalledTimes(1);
  expect(await axe(rowEl)).toHaveNoViolations();

  row.setLinkedContent({ label: 'Plan', ariaLabel: 'Linked content: Notes/Plan.md', onActivate });
  expect(view.getByRole('button', { name: 'Linked content: Notes/Plan.md' })).toBeDefined();
  expect(view.queryByRole('button', { name: /^Remove/ })).toBeNull();
  row.destroy();
});

it('keeps missing linked content visible and marked', async () => {
  const { row, rowEl, view } = mount();

  row.setLinkedContent({
    label: 'Plan · Missing content',
    icon: 'file-question',
    ariaLabel: 'Linked content: Notes/Plan.md. Missing content',
    missing: true,
    onActivate: jest.fn(),
  });

  const note = view.getByRole('button', { name: 'Linked content: Notes/Plan.md. Missing content' });
  expect(note.textContent).toBe('Plan · Missing content');
  expect(note.closest('.claudian-input-info-linked')?.classList.contains('claudian-input-info-linked--missing')).toBe(true);
  expect(rowEl.classList.contains('claudian-hidden')).toBe(false);
  expect(await axe(rowEl)).toHaveNoViolations();
  row.destroy();
});

it('keeps reserving its row while there is no linked note', () => {
  const { row, rowEl } = mount();
  expect(rowEl.classList.contains('claudian-hidden')).toBe(false);

  row.setLinkedContent({ label: 'Plan', ariaLabel: 'Linked content: Notes/Plan.md', onActivate: jest.fn() });
  expect(within(rowEl).getByRole('button', { name: 'Linked content: Notes/Plan.md' })).toBeDefined();

  row.setLinkedContent(null);
  expect(rowEl.classList.contains('claudian-hidden')).toBe(false);
  expect(within(rowEl).queryByRole('button')).toBeNull();
  row.destroy();
});

it('shows the project in its own slot before the linked note, as a menu button unless disabled', async () => {
  const { row, rowEl, view } = mount();
  const onActivate = jest.fn();

  row.setLinkedContent({ label: 'Plan', ariaLabel: 'Linked content: Notes/Plan.md', onActivate: jest.fn() });
  row.setProject({ label: 'Launch', icon: 'folder', ariaLabel: 'Project: Launch', hasPopup: 'menu', onActivate });

  const project = view.getByRole('button', { name: 'Project: Launch' });
  expect(project.getAttribute('type')).toBe('button');
  expect(project.getAttribute('aria-haspopup')).toBe('menu');
  expect(project.textContent).toBe('Launch');
  const linked = view.getByRole('button', { name: 'Linked content: Notes/Plan.md' });
  expect(project.compareDocumentPosition(linked) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(project);
  expect(onActivate).toHaveBeenCalledTimes(1);
  // The chip anchors its menu.
  expect(onActivate.mock.calls[0][0]).toBe(project);
  expect(await axe(rowEl)).toHaveNoViolations();

  row.setProject({ label: 'Launch', icon: 'folder', ariaLabel: 'Project: Launch', hasPopup: 'menu', disabled: true, onActivate });
  const disabled = view.getByRole('button', { name: 'Project: Launch' }) as HTMLButtonElement;
  expect(disabled.disabled).toBe(true);
  fireEvent.click(disabled);
  expect(onActivate).toHaveBeenCalledTimes(1);
  expect(await axe(rowEl)).toHaveNoViolations();

  row.setLinkedContent(null);
  expect(view.getByRole('button', { name: 'Project: Launch' })).toBe(disabled);
  row.setProject(null);
  expect(view.queryByRole('button', { name: 'Project: Launch' })).toBeNull();
  row.destroy();
});
