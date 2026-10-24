import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { testDate } from '@test/helpers/testClock';
import type { App } from 'obsidian';

import { ProjectStore } from '@/app/projects/ProjectStore';
import { PROJECTS_PATH } from '@/core/bootstrap/storagePaths';
import { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';

it('loads valid projects beside dangling record links without following or deleting them', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-project-list-'));
  const resolve = (relative: string) => path.join(root, ...relative.split('/'));
  const adapter = {
    getBasePath: () => root,
    read: (relative: string) => fs.readFile(resolve(relative), 'utf8'),
    // The desktop host stats entries through symlinks; one dangling link rejects a normal list.
    list: async (relative: string) => {
      const names = await fs.readdir(resolve(relative));
      const entries = await Promise.all(names.map(async name => ({
        name, stat: await fs.stat(resolve(`${relative}/${name}`)),
      })));
      return {
        files: entries.filter(entry => entry.stat.isFile()).map(entry => `${relative}/${entry.name}`),
        folders: entries.filter(entry => entry.stat.isDirectory()).map(entry => `${relative}/${entry.name}`),
      };
    },
  };
  const files = new VaultFileAdapter({ vault: { adapter } } as unknown as App);
  const record = {
    id: 'valid-project', name: 'Release', instructions: 'Ship it',
    memoryPath: 'Release/MEMORY.md', isPinned: false, createdAt: testDate().getTime(),
  };
  const brokenLink = `${PROJECTS_PATH}/broken-project.json`;
  try {
    await fs.mkdir(resolve(PROJECTS_PATH), { recursive: true });
    await fs.writeFile(resolve(`${PROJECTS_PATH}/${record.id}.json`), JSON.stringify(record));
    await fs.symlink(resolve('missing-project.json'), resolve(brokenLink), 'file');

    const loaded = await new ProjectStore(files).load();
    expect(loaded).toEqual({ records: [record], invalidCount: 1 });
    expect((await fs.lstat(resolve(brokenLink))).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await fs.readFile(resolve(`${PROJECTS_PATH}/${record.id}.json`), 'utf8'))).toEqual(record);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
