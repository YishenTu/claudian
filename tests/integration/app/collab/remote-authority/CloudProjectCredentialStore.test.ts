import { existsSync } from 'node:fs';
import type * as FileSystem from 'node:fs/promises';
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CloudProjectCredentialStore } from '@/app/collab/remote-authority/CloudProjectCredentialStore';

const PROJECT = 'project-vault-identity';
let directory: string;

beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'cloud-vault-identity-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it('keeps identity when the Vault moves to another device and separates a fresh Vault', async () => {
  const source = path.join(directory, 'source');
  const copy = path.join(directory, 'copy');
  const independent = path.join(directory, 'independent');
  await mkdir(source);
  await mkdir(independent);
  const first = await new CloudProjectCredentialStore(source).getOrCreate(PROJECT);
  await cp(source, copy, { recursive: true });
  expect(await new CloudProjectCredentialStore(copy).require(PROJECT)).toEqual(first);
  const other = await new CloudProjectCredentialStore(independent).getOrCreate(PROJECT);
  expect(other.principalId).not.toBe(first.principalId);
  expect(other.credential).not.toBe(first.credential);
});

it('derives the principal from a fixed credential and never replaces invalid or missing required state', async () => {
  const store = new CloudProjectCredentialStore(directory);
  const first = await store.getOrCreate(PROJECT);
  const file = path.join(directory, '.claudian/collab/cloud-credentials', `${PROJECT}.json`);
  await writeFile(file, JSON.stringify({ schemaVersion: 1, projectId: PROJECT, credential: '0'.repeat(64) }));
  expect(await store.require(PROJECT)).toEqual({
    credential: '0'.repeat(64),
    principalId: 'vault-60e05bd1b195af2f94112fa7197a5c88289058840ce7c6df9693756bc6250f55',
  });
  await writeFile(file, '{invalid credential');
  await expect(store.getOrCreate(PROJECT)).rejects.toMatchObject({ code: 'durable-progress-recovery-required' });
  expect(await readFile(file, 'utf8')).toBe('{invalid credential');
  await rm(file);
  await expect(store.require(PROJECT)).rejects.toMatchObject({ code: 'durable-progress-recovery-required' });
  expect(first.credential).toHaveLength(64);
});

it('publishes one private credential for concurrent admissions and rejects a symlink', async () => {
  const store = new CloudProjectCredentialStore(directory);
  const identities = await Promise.all(Array.from({ length: 8 }, () => store.getOrCreate(PROJECT)));
  expect(identities.every(value => value.credential === identities[0].credential)).toBe(true);
  const file = path.join(directory, '.claudian/collab/cloud-credentials', `${PROJECT}.json`);
  const mode = (await stat(file)).mode & 0o777;
  expect(process.platform === 'win32' || mode === 0o600).toBe(true);
  const outside = path.join(directory, 'unrelated.json');
  await writeFile(outside, await readFile(file));
  await rm(file);
  await symlink(outside, file);
  await expect(store.getOrCreate(PROJECT)).rejects.toMatchObject({ code: 'durable-progress-recovery-required' });
});

it('does not expose a credential until its directory entry is durably synchronized', async () => {
  const file = path.join(directory, '.claudian/collab/cloud-credentials', `${PROJECT}.json`);
  const filesystem = jest.requireActual<typeof FileSystem>('node:fs/promises');
  const open = filesystem.open;
  const fault = jest.spyOn(filesystem, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === path.dirname(file) && existsSync(file)) {
      handle.sync = () => Promise.reject(Object.assign(new Error('Injected directory sync failure'), { code: 'EIO' }));
    }
    return handle;
  });
  try {
    await expect(new CloudProjectCredentialStore(directory).getOrCreate(PROJECT)).rejects.toMatchObject({ code: 'durable-progress-recovery-required' });
    await expect(new CloudProjectCredentialStore(directory).require(PROJECT)).rejects.toMatchObject({ code: 'durable-progress-recovery-required' });
  } finally { fault.mockRestore(); }
  const stored = JSON.parse(await readFile(file, 'utf8')) as { credential: string };
  expect((await new CloudProjectCredentialStore(directory).require(PROJECT)).credential).toBe(stored.credential);
});
