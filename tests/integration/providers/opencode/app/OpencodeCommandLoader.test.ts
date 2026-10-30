// @test-ci {"native":true,"inputs":["tests/helpers/providers/opencode/OpencodeNativePeer.cjs"]}
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { OpencodeCommandLoader } from '@/providers/opencode/app/OpencodeCommandLoader';

import { createOpencodeHTTPMetadataFixture, type OpencodeHTTPMetadataFixture, waitUntil } from '../metadata/OpencodeHTTPMetadataFixture';

let fixture: OpencodeHTTPMetadataFixture;
beforeEach(() => { fixture = createOpencodeHTTPMetadataFixture(); });
afterEach(() => fixture.dispose());

it('uses a ready command snapshot without starting native discovery', async () => {
  const { host } = await fixture.createHostFixture();
  await expect(new OpencodeCommandLoader().loadCommands({
    plugin: host, conversation: null, allowIsolatedMetadataCreation: false,
    readyCommandSnapshot: [{ content: '', id: 'opencode:test', kind: 'command', name: 'test', source: 'sdk' }],
  })).resolves.toMatchObject({ items: [expect.objectContaining({ name: 'test' })], status: 'ready' });
  expect(existsSync(fixture.environment.ENDPOINT_FILE!)).toBe(false);
});

it('requires authorization before starting isolated metadata discovery', async () => {
  const { host } = await fixture.createHostFixture();
  await expect(new OpencodeCommandLoader().loadCommands({
    plugin: host, conversation: null, allowIsolatedMetadataCreation: false,
  })).resolves.toMatchObject({ status: 'requires-session' });
  expect(existsSync(fixture.environment.ENDPOINT_FILE!)).toBe(false);
});

it('treats an observed empty catalog as valid and closes its owned native server', async () => {
  writeFileSync(fixture.environment.CATALOG_FILE + '.commands', '[]');
  writeFileSync(fixture.environment.CATALOG_FILE + '.skills', '[]');
  const { host } = await fixture.createHostFixture();
  await expect(new OpencodeCommandLoader().loadCommands({
    plugin: host, conversation: null, allowIsolatedMetadataCreation: true,
  })).resolves.toEqual({ status: 'empty' });
  await expect(fetch(readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8'))).rejects.toThrow();
});

it('reports retryable discovery failure when the native catalog cannot be read', async () => {
  writeFileSync(fixture.environment.CATALOG_FILE + '.command-error', '');
  const { host } = await fixture.createHostFixture();
  await expect(new OpencodeCommandLoader().loadCommands({
    plugin: host, conversation: null, allowIsolatedMetadataCreation: true,
  })).resolves.toEqual({ message: 'Could not load OpenCode commands.', retryable: true, status: 'error' });
  await expect(fetch(readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8'))).rejects.toThrow();
});

it('preserves caller cancellation and closes the owned server during native activation', async () => {
  writeFileSync(fixture.environment.CATALOG_FILE + '.activation-hold', '');
  const { host } = await fixture.createHostFixture();
  const controller = new AbortController();
  const failure = new Error('caller cancelled');
  const pending = new OpencodeCommandLoader().loadCommands({
    plugin: host, conversation: null, allowIsolatedMetadataCreation: true, signal: controller.signal,
  });
  const outcome = pending.then(value => ({ value }), error => ({ error }));
  await waitUntil(() => existsSync(fixture.environment.ENDPOINT_FILE + '.integration'));
  controller.abort(failure);
  expect(await outcome).toEqual({ error: failure });
  await expect(fetch(readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8'))).rejects.toThrow();
});
