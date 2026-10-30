import { existsSync } from 'node:fs';

import { createFeatureHostFixture } from '@test/helpers/FeatureHostFixture';
import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';

import { CLAUDIAN_SETTINGS_PATH } from '@/core/bootstrap/storagePaths';

it('publishes chat mutations through an existing feature fixture settings owner', async () => {
  const published = vi.fn();
  const fixture = await createFeatureHostFixture({ afterPublish: published });
  const chat = await createChatFeatureHost({ fixture });
  await chat.mutateSettings(settings => { settings.locale = 'fr'; });
  expect(fixture.coordinator.getCommittedSettings().locale).toBe('fr');
  expect(fixture.providerHost.settings.locale).toBe('fr');
  expect(published).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await fixture.vault.read(CLAUDIAN_SETTINGS_PATH)).locale).toBe('fr');
});

it('shares one durable settings transaction between the feature, provider and runtime hosts', async () => {
  let finishWrite!: () => void;
  let signalWriting!: () => void;
  const pending = new Promise<void>(resolve => { finishWrite = resolve; });
  const writing = new Promise<void>(resolve => { signalWriting = resolve; });
  const publish = vi.fn();
  const fixture = await createFeatureHostFixture({
    settings: { providerConfigs: { codex: { enabled: true } } },
    beforePersist: async () => { signalWriting(); await pending; },
    afterPublish: publish,
  });
  const runtime = fixture.providerHost.getRuntimeHost('codex');
  const change = runtime.updateConfig(config => { config.enabled = false; return true; });
  await writing;
  expect(runtime.config.enabled).toBe(true);
  expect(fixture.host.getCommittedSettings().providerConfigs.codex?.enabled).toBe(true);
  finishWrite();
  await expect(change).resolves.toBe(true);
  expect(runtime.config.enabled).toBe(false);
  expect(fixture.host.getCommittedSettings()).toBe(fixture.providerHost.settings);
  expect(fixture.host.storage.getAdapter()).toBe(fixture.vault.files);
  expect(JSON.parse(await fixture.vault.read(CLAUDIAN_SETTINGS_PATH)).providerConfigs.codex.enabled).toBe(false);
  publish.mockRejectedValueOnce(new Error('Publication failed'));
  await expect(runtime.updateConfig(config => { config.enabled = true; return true; }))
    .rejects.toMatchObject({ committed: true, phase: 'post-commit', cause: new Error('Publication failed') });
  expect(runtime.config.enabled).toBe(true);
  expect(publish.mock.calls.at(-1)?.[1].providerConfigs.codex.enabled).toBe(false);
  expect(JSON.parse(await fixture.vault.read(CLAUDIAN_SETTINGS_PATH)).providerConfigs.codex.enabled).toBe(true);
  await fixture.host.notifyAgentSkillsChanged();
  expect(fixture.host.getAgentSkillResourceGeneration()).toBe(1);
});

it('rejects failed persistence without publishing runtime state and disposes owned resources once', async () => {
  const fixture = await createProviderHostFixture({
    settings: { providerConfigs: { codex: { enabled: true } } },
    beforePersist: async () => { throw new Error('Disk unavailable'); },
  });
  expect(fixture.host.workingDirectory).toBe(fixture.vault.root);
  const runtime = fixture.host.getRuntimeHost('codex');
  await expect(runtime.updateConfig(config => { config.enabled = false; return true; })).rejects.toThrow('Disk unavailable');
  expect(runtime.config.enabled).toBe(true);
  expect(await fixture.vault.exists(CLAUDIAN_SETTINGS_PATH)).toBe(false);
  await expect(fixture.host.getResolvedProviderCliPath('codex')).resolves.toBeNull();
  const first = fixture.dispose();
  expect(fixture.dispose()).toBe(first);
  await first;
  expect(existsSync(fixture.vault.root)).toBe(false);
});
