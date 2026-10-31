/** @vitest-environment jsdom */
import { axe } from '@test/helpers/accessibility';
import { within } from '@testing-library/dom';
import { App } from 'obsidian';

import { AccessibleModal, setModalAccessibility } from '@/shared/modals/AccessibleModal';

it('names simultaneous host dialogs from their visible titles and follows title changes', async () => {
  const first = new AccessibleModal(new App()).setTitle('Edit skill');
  const second = new AccessibleModal(new App()).setTitle('Delete skill');
  try {
    first.open();
    second.open();
    const ui = within(document.body);
    expect(ui.getByRole('dialog', { name: 'Edit skill' })).toBe(first.modalEl);
    expect(ui.getByRole('dialog', { name: 'Delete skill' })).toBe(second.modalEl);
    expect(first.modalEl.getAttribute('aria-modal')).toBe('true');
    expect(second.modalEl.getAttribute('aria-modal')).toBe('true');
    first.setTitle('Rename skill');
    expect(ui.getByRole('dialog', { name: 'Rename skill' })).toBe(first.modalEl);
    expect(ui.queryByRole('dialog', { name: 'Edit skill' })).toBeNull();
    expect(await axe(document.body, {
      runOnly: ['aria-dialog-name', 'aria-allowed-role', 'aria-valid-attr-value', 'duplicate-id-aria'],
    })).toHaveNoViolations();
  } finally {
    second.close();
    first.close();
  }
});

it('uses an explicit name for a titleless dialog and can switch to a visible title', async () => {
  const dialog = document.body.createDiv();
  try {
    setModalAccessibility(dialog, 'Preview diagram.png');
    const ui = within(document.body);
    expect(ui.getByRole('dialog', { name: 'Preview diagram.png' })).toBe(dialog);
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(await axe(dialog, { runOnly: ['aria-dialog-name', 'aria-valid-attr-value'] })).toHaveNoViolations();

    const title = dialog.createDiv({ text: 'Diagram preview' });
    setModalAccessibility(dialog, title);
    expect(ui.getByRole('dialog', { name: 'Diagram preview' })).toBe(dialog);
    expect(dialog.hasAttribute('aria-label')).toBe(false);
    setModalAccessibility(dialog, 'Preview updated.png');
    title.remove();
    expect(ui.getByRole('dialog', { name: 'Preview updated.png' })).toBe(dialog);
    expect(dialog.hasAttribute('aria-labelledby')).toBe(false);
  } finally {
    dialog.remove();
  }
});
