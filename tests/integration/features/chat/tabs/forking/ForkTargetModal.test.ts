/** @vitest-environment jsdom */

import { axe } from '@test/helpers/accessibility';
import { fireEvent, screen, within } from '@testing-library/dom';
import { App } from 'obsidian';

import { chooseForkTarget } from '@/features/chat/tabs/forking/ForkTargetModal';

afterEach(() => { document.body.replaceChildren(); });

it.each([
  ['Current tab', 'current-tab'],
  ['New tab', 'new-tab'],
] as const)('chooses %s and closes the dialog', async (name, target) => {
  const result = chooseForkTarget(new App());
  const dialog = screen.getByRole('dialog', { name: 'Fork conversation' });
  const button = within(dialog).getByRole('button', { name });
  expect(button.getAttribute('type')).toBe('button');
  fireEvent.click(button);
  expect(await result).toBe(target);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('exposes accessible choices and resolves cancellation when the host closes it', async () => {
  const result = chooseForkTarget(new App());
  const dialog = screen.getByRole('dialog', { name: 'Fork conversation' });
  expect(within(dialog).getAllByRole('button').map(button => button.textContent)).toEqual(['Current tab', 'New tab']);
  expect(await axe(dialog)).toHaveNoViolations();
  fireEvent.click(dialog.querySelector<HTMLElement>('.modal-header-button')!);
  expect(await result).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
});
