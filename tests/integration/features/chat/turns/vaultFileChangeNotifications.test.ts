import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { TFile } from 'obsidian';

import { notifyVaultFileChange } from '@/features/chat/turns/vaultFileChangeNotifications';

// Junctions also allow this fixture to run without Windows symlink privileges.
describe('vault file notifications through a linked vault root', () => {
  let vault: DesktopVault;
  let linkedRoot: string;

  beforeEach(async () => {
    vault = await DesktopVault.create();
    linkedRoot = `${vault.root}-link`;
    await fs.symlink(vault.root, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    Object.assign(vault.app.vault.adapter, { basePath: linkedRoot });
    await vault.write('notes/existing.md', 'updated');
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fs.rm(linkedRoot, { force: true });
    await vault.dispose();
  });

  it.each(['canonical', 'relative', 'linked'] as const)('refreshes an indexed file reported by its %s path', async (form) => {
    const file = Object.assign(new TFile(), { path: 'notes/existing.md' });
    vi.spyOn(vault.app.vault, 'getAllLoadedFiles').mockReturnValue([file]);
    const modified = vi.fn();
    vault.app.vault.on('modify', modified);
    const filePath = form === 'canonical' ? vault.resolve('notes/existing.md')
      : form === 'linked' ? path.join(linkedRoot, 'notes/existing.md') : 'notes/existing.md';

    notifyVaultFileChange(vault.app, { file_path: filePath });
    await vi.advanceTimersByTimeAsync(200);

    expect(modified).toHaveBeenCalledWith(file);
  });

  it('scans the vault-relative parent of an unindexed canonical file', async () => {
    const list = vi.spyOn(vault.app.vault.adapter, 'list');

    notifyVaultFileChange(vault.app, { file_path: vault.resolve('notes/new.md') });
    await vi.advanceTimersByTimeAsync(200);

    expect(list).toHaveBeenCalledWith('notes');
    await expect(list.mock.results[0].value).resolves.toEqual({ files: ['notes/existing.md'], folders: [] });
  });

  it('does not treat the canonical vault root as a file', async () => {
    const lookup = vi.spyOn(vault.app.vault, 'getAbstractFileByPath');
    const list = vi.spyOn(vault.app.vault.adapter, 'list');

    notifyVaultFileChange(vault.app, { file_path: vault.root });
    await vi.advanceTimersByTimeAsync(200);

    expect(lookup).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it('preserves an internal link name in an already vault-relative path', async () => {
    await fs.symlink(path.join(vault.root, 'notes'), path.join(vault.root, 'alias'),
      process.platform === 'win32' ? 'junction' : 'dir');
    const file = Object.assign(new TFile(), { path: 'alias/existing.md' });
    vi.spyOn(vault.app.vault, 'getAllLoadedFiles').mockReturnValue([file]);
    const modified = vi.fn();
    vault.app.vault.on('modify', modified);

    notifyVaultFileChange(vault.app, { file_path: path.join(linkedRoot, 'alias/existing.md') });
    await vi.advanceTimersByTimeAsync(200);

    expect(modified).toHaveBeenCalledWith(file);
  });
});
