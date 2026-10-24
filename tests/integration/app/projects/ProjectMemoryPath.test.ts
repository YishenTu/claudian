import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { App } from 'obsidian';

import { ProjectService } from '@/app/projects/ProjectService';
import { ProjectStore } from '@/app/projects/ProjectStore';
import { PROJECTS_PATH } from '@/core/bootstrap/storagePaths';
import { defaultProjectMemoryPath } from '@/core/path/ProjectMemoryPath';
import { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';

it.each([46, 47])('keeps generated Unicode memory paths identical to their native filenames at a %s-unit prefix', async prefixLength => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-project-unicode-'));
  const resolve = (relative: string) => path.join(root, ...relative.split('/'));
  const adapter = {
    getBasePath: () => root,
    mkdir: (relative: string) => fs.mkdir(resolve(relative), { recursive: true }),
    read: (relative: string) => fs.readFile(resolve(relative), 'utf8'),
    remove: (relative: string) => fs.unlink(resolve(relative)),
    stat: async (relative: string) => {
      const stat = await fs.stat(resolve(relative));
      return { type: stat.isDirectory() ? 'folder' : 'file', mtime: stat.mtimeMs, ctime: stat.ctimeMs, size: stat.size };
    },
    list: async (relative: string) => {
      const entries = await fs.readdir(resolve(relative), { withFileTypes: true });
      return {
        files: entries.filter(entry => entry.isFile()).map(entry => `${relative}/${entry.name}`),
        folders: entries.filter(entry => entry.isDirectory()).map(entry => `${relative}/${entry.name}`),
      };
    },
  };
  const files = new VaultFileAdapter({ vault: { adapter } } as unknown as App);
  const store = new ProjectStore(files);
  const service = new ProjectService([], { store, memory: files });
  const prefix = 'a'.repeat(prefixLength);
  const name = `${prefix}𠀀`;
  // Retain the existing 48 UTF-16-unit budget; keep the supplementary character only when both units fit.
  const folder = prefixLength === 46 ? name : prefix;
  const expectedPath = `${PROJECTS_PATH}/${folder}/MEMORY.md`;
  try {
    const record = await service.create({ name, instructions: '', memoryPath: defaultProjectMemoryPath(name) });
    expect(await fs.readdir(resolve(PROJECTS_PATH))).toContain(folder);
    expect(record.memoryPath).toBe(expectedPath);
    const loaded = await store.load();
    expect(loaded.records[0].memoryPath).toBe(expectedPath);
    const reopened = new ProjectService(loaded.records, { store, memory: files });
    expect(await reopened.readMemory(record.id)).toMatchObject({ content: expect.stringContaining(`# ${name}`) });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
