/** @jest-environment jsdom */

import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { fireEvent, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import type { App } from 'obsidian';

import { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import { ClaudeCommandCatalog } from '@/providers/claude/commands/ClaudeCommandCatalog';
import { SkillStorage } from '@/providers/claude/storage/SkillStorage';
import { SlashCommandStorage } from '@/providers/claude/storage/SlashCommandStorage';
import { SlashCommandSettings } from '@/providers/claude/ui/SlashCommandSettings';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };

describe('Claude command settings with vault storage', () => {
  let root: string;
  let app: App;
  let catalog: ClaudeCommandCatalog;
  let form: HTMLFormElement;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'claudian-command-settings-'));
    app = { vault: { adapter: {
      exists: (file: string) => fs.access(path.join(root, file)).then(() => true, () => false),
      read: (file: string) => fs.readFile(path.join(root, file), 'utf8'),
      write: (file: string, content: string) => fs.writeFile(path.join(root, file), content),
      mkdir: (folder: string) => fs.mkdir(path.join(root, folder), { recursive: true }),
      remove: (file: string) => fs.unlink(path.join(root, file)),
      rmdir: (folder: string) => fs.rmdir(path.join(root, folder)),
      list: async (folder: string) => {
        const entries = await fs.readdir(path.join(root, folder), { withFileTypes: true });
        return {
          files: entries.filter(entry => entry.isFile()).map(entry => `${folder}/${entry.name}`),
          folders: entries.filter(entry => entry.isDirectory()).map(entry => `${folder}/${entry.name}`),
        };
      },
    } } } as unknown as App;
    const adapter = new VaultFileAdapter(app);
    catalog = new ClaudeCommandCatalog(new SlashCommandStorage(adapter), new SkillStorage(adapter));
    form = document.createElement('form');
    form.setAttribute('aria-label', 'Claude commands');
    document.body.appendChild(form);
  });

  afterEach(async () => {
    await catalog.dispose();
    document.body.replaceChildren();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('converts a stored command to a skill and refreshes the controls without submitting the form', async () => {
    await fs.mkdir(path.join(root, '.claude/commands'), { recursive: true });
    await fs.writeFile(path.join(root, '.claude/commands/review.md'),
      '---\ndescription: Review changes\n---\nReview the current changes.');
    let submitted = false;
    form.addEventListener('submit', event => { event.preventDefault(); submitted = true; });
    new SlashCommandSettings(form, app, catalog);

    const convert = await within(form).findByRole('button', { name: 'Convert to skill' });
    fireEvent.click(convert);

    await waitFor(() => expect(within(form).queryByRole('button', { name: 'Convert to skill' })).toBeNull());
    expect(within(form).getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(await catalog.listVaultEntries()).toMatchObject([{
      kind: 'skill', name: 'review', description: 'Review changes', content: 'Review the current changes.',
    }]);
    expect(submitted).toBe(false);
    expect(await axe(form)).toHaveNoViolations();
  });

  it('deletes a stored command and displays the empty state without submitting the form', async () => {
    await fs.mkdir(path.join(root, '.claude/commands'), { recursive: true });
    await fs.writeFile(path.join(root, '.claude/commands/review.md'), 'Review the current changes.');
    let submitted = false;
    form.addEventListener('submit', event => { event.preventDefault(); submitted = true; });
    new SlashCommandSettings(form, app, catalog);

    fireEvent.click(await within(form).findByRole('button', { name: 'Delete' }));

    await within(form).findByText('No commands or skills configured. Click + to create one.');
    expect(within(form).getByRole('button', { name: 'Add' })).toBeTruthy();
    expect(await catalog.listVaultEntries()).toEqual([]);
    expect(submitted).toBe(false);
    expect(await axe(form)).toHaveNoViolations();
  });

  it('shows why commands are unavailable when the repository is absent', async () => {
    new SlashCommandSettings(form, app, null);

    expect(within(form).getByText('Claude command catalog is unavailable.')).toBeTruthy();
    expect(within(form).queryByRole('button', { name: 'Add' })).toBeNull();
    expect(await axe(form)).toHaveNoViolations();
  });
});
