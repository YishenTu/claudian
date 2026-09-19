/** @jest-environment jsdom */
import { MemoryDataAdapter } from '@test/helpers/MemoryDataAdapter';
import { fireEvent, screen, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import type { App } from 'obsidian';

import { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import { t } from '@/i18n/i18n';
import { CodexSubagentStorage } from '@/providers/codex/storage/CodexSubagentStorage';
import { CodexSubagentSettings } from '@/providers/codex/ui/CodexSubagentSettings';

jest.mock('obsidian', () => ({
  ...jest.requireActual('@test/__mocks__/obsidian'),
  ...jest.requireActual('@test/helpers/ObsidianSettingsDom'),
}));

it('saves native Codex options through the editor controls', async () => {
  const app = { vault: { adapter: new MemoryDataAdapter() } } as unknown as App;
  const storage = new CodexSubagentStorage(new VaultFileAdapter(app));
  const container = document.body.appendChild(document.createElement('div'));
  new CodexSubagentSettings(container, storage, app);
  fireEvent.click(await screen.findByRole('button', { name: t('common.add') }));
  const dialog = screen.getByRole('dialog');
  const controls = within(dialog);
  for (const [name, value] of [
    [t('settings.subagents.modal.name'), 'reviewer'],
    [t('settings.subagents.modal.description'), 'Review changes'],
    [t('settings.codexSubagents.developerInstructions.name'), 'Check correctness'],
  ]) {
    fireEvent.input(controls.getByRole('textbox', { name }), { target: { value } });
  }
  fireEvent.click(controls.getByText(t('settings.subagents.modal.advancedOptions')));
  // jsdom does not perform the summary element's native default toggle.
  dialog.querySelector('details')!.open = true;
  fireEvent.change(controls.getByRole('combobox', { name: t('settings.codexSubagents.reasoningEffort.name') }), { target: { value: 'high' } });
  fireEvent.change(controls.getByRole('combobox', { name: t('settings.codexSubagents.sandboxMode.name') }), { target: { value: 'read-only' } });
  expect((await axe(dialog)).violations).toEqual([]);
  fireEvent.click(controls.getByRole('button', { name: t('common.save') }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(await storage.loadAll()).toEqual([expect.objectContaining({
    name: 'reviewer', modelReasoningEffort: 'high', sandboxMode: 'read-only', developerInstructions: 'Check correctness',
  })]);
});
