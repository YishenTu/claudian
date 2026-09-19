/** @jest-environment jsdom */

import { fireEvent, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import type { App } from 'obsidian';

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian');
  class Setting {
    private container: HTMLElement;
    private name = '';
    constructor(container: HTMLElement) { this.container = container.createDiv(); }
    setName(name: string) { this.name = name; return this; }
    setDesc() { return this; }
    addText(callback: (control: unknown) => void) {
      const inputEl = this.container.createEl('input', { attr: { 'aria-label': this.name } });
      callback({ inputEl,
        setValue(value: string) { inputEl.value = value; return this; },
        setPlaceholder(value: string) { inputEl.placeholder = value; return this; },
      });
      return this;
    }
    addDropdown(callback: (control: unknown) => void) {
      const selectEl = this.container.createEl('select', { attr: { 'aria-label': this.name } });
      callback({ selectEl,
        addOption(value: string, label: string) { selectEl.add(new Option(label, value)); return this; },
        setValue(value: string) { selectEl.value = value; return this; },
        onChange(fn: (value: string) => void) {
          selectEl.addEventListener('change', () => fn(selectEl.value)); return this;
        },
      });
      return this;
    }
  }
  class Modal {
    modalEl = document.createElement('div');
    contentEl = this.modalEl.createDiv();
    setTitle(title: string) { this.modalEl.setAttribute('aria-label', title); }
    open() { document.body.appendChild(this.modalEl); (this as unknown as { onOpen(): void }).onOpen(); }
    close() { this.modalEl.remove(); }
  }
  return { ...actual, Setting, Modal, setIcon() {} };
});

jest.mock('fs', () => ({ ...jest.requireActual('fs'), promises: {
  ...jest.requireActual('fs').promises,
  readFile: jest.fn(), readdir: jest.fn(), realpath: jest.fn(),
} }));

import { promises as fs } from 'fs';

import { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import { AgentManager } from '@/providers/claude/agents/AgentManager';
import { parseAgentFile } from '@/providers/claude/agents/AgentStorage';
import { ClaudePluginDiscovery } from '@/providers/claude/plugins/ClaudePluginDiscovery';
import { AgentVaultStorage } from '@/providers/claude/storage/AgentVaultStorage';
import { AgentSettings } from '@/providers/claude/ui/AgentSettings';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...names: string[]) { this.classList.add(...names); };

it.each(['review', 'Explore', '[review]', 'review #2'])('preserves the existing name and model when editing %s', async (name) => {
  let contents = `---\nname: ${JSON.stringify(name)}\ndescription: Review code\nmodel: regional/Custom-Model-V2\n---\nReview carefully.`;
  jest.mocked(fs.readFile).mockImplementation(async () => contents);
  jest.mocked(fs.readdir).mockImplementation(async (folder) => (
    String(folder) === '/vault/.claude/agents'
      ? [{ name: 'review.md', isFile: () => true }] as never
      : []
  ));
  const app = { vault: { adapter: {
    read: async () => contents,
    exists: async () => true,
    write: async (_path: string, value: string) => { contents = value; },
  } } } as unknown as App;
  const agentManager = new AgentManager('/vault', new ClaudePluginDiscovery('/vault'));
  await agentManager.loadAgents();
  const container = document.body.createDiv();
  new AgentSettings(container, {
    app, agentManager, agentStorage: new AgentVaultStorage(new VaultFileAdapter(app)),
  });
  fireEvent.click(within(container).getByRole('button', { name: 'Edit' }));
  const select = await within(document.body).findByRole('combobox', { name: 'Model' }) as HTMLSelectElement;
  expect(select.value).toBe('regional/Custom-Model-V2');
  expect(within(select).getByRole('option', { name: 'regional/Custom-Model-V2' })).toBeTruthy();
  expect(await axe(select.parentElement!)).toHaveNoViolations();
  fireEvent.click(within(document.body).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(contents).toContain('model: regional/Custom-Model-V2\n'));
  await waitFor(() => expect(within(document.body).queryByRole('combobox')).toBeNull());
  expect(parseAgentFile(contents)?.frontmatter.name).toBe(name);
  expect(within(container).getByRole('button', { name: 'Edit' })).toBeTruthy();
  container.remove();
});
