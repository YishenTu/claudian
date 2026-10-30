/** @vitest-environment jsdom */
import { axe } from '@test/helpers/accessibility';
import { fireEvent, screen, within } from '@testing-library/dom';
import { App } from 'obsidian';

import { confirm, confirmDelete } from '@/shared/modals/ConfirmModal';

// Production owns dialog semantics; the shared host owns modal mounting and close lifecycle.
afterEach(() => { document.body.replaceChildren(); });

describe('ConfirmModal', () => {
  it('confirmDelete resolves true when confirm button is clicked', async () => {
    const result = confirmDelete(new App(), 'Are you sure?');
    const dialog = screen.getByRole('dialog', { name: 'Confirm' });
    expect(within(dialog).getByText('Are you sure?')).toBeDefined();
    expect(within(dialog).getAllByRole('button')).toHaveLength(2);
    const button = within(dialog).getByRole('button', { name: 'Delete' });
    expect(button.classList.contains('mod-destructive')).toBe(true);
    expect(await axe(dialog)).toHaveNoViolations();
    fireEvent.click(button);
    await expect(result).resolves.toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(dialog).queryByText('Are you sure?')).toBeNull();
  });

  it('confirmDelete resolves false when closed without confirming', async () => {
    const result = confirmDelete(new App(), 'Are you sure?');
    const dialog = screen.getByRole('dialog', { name: 'Confirm' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await expect(result).resolves.toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(dialog).queryByText('Are you sure?')).toBeNull();
  });

  it('confirm resolves true when confirm button is clicked', async () => {
    const result = confirm(new App(), 'Proceed?', 'Confirm');
    const dialog = screen.getByRole('dialog', { name: 'Confirm' });
    expect(within(dialog).getAllByRole('button')).toHaveLength(2);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await expect(result).resolves.toBe(true);
  });
});
