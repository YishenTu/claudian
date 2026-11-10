import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { TFile } from 'obsidian';

import { notifyVaultFileChange } from '@/features/chat/turns/vaultFileChangeNotifications';

it.each([
  { vaultDirectory: '', relativePath: 'notes/$TASK_LITERAL.md', absolute: false },
  { vaultDirectory: '', relativePath: 'notes/$TASK_LITERAL.md', absolute: true },
  { vaultDirectory: '', relativePath: 'notes/$TASK_LITERAL/note.md', absolute: true },
  { vaultDirectory: '$TASK_LITERAL-vault', relativePath: 'notes/note.md', absolute: true },
])('refreshes a literal provider path without expanding environment syntax: %j', async ({ vaultDirectory, relativePath, absolute }) => {
  const vault = await DesktopVault.create();
  try {
    vi.stubEnv('TASK_LITERAL', 'expanded');
    const vaultPath = path.join(vault.root, vaultDirectory);
    const absolutePath = path.join(vaultPath, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, 'Updated note');
    Object.assign(vault.app.vault.adapter, { basePath: vaultPath });
    const file = Object.assign(new TFile(), { path: relativePath });
    vi.spyOn(vault.app.vault, 'getAllLoadedFiles').mockReturnValue([file]);
    const modified = vi.fn();
    vault.app.vault.on('modify', modified);
    vi.useFakeTimers();

    notifyVaultFileChange(vault.app, { file_path: absolute ? absolutePath : relativePath });
    await vi.advanceTimersByTimeAsync(200);

    expect(modified).toHaveBeenCalledWith(file);
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await vault.dispose();
  }
});
