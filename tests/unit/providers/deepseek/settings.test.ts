import { getInstallationKey } from '@/core/device/InstallationKey';
import { deepseekModelPolicy } from '@/providers/deepseek/DeepSeekModelPolicy';
import { decodeDeepSeekModelId, encodeDeepSeekModelId } from '@/providers/deepseek/models';
import {
  getDeepSeekProviderSettings,
  projectDeepSeekModelSettings,
  updateDeepSeekProviderSettings,
} from '@/providers/deepseek/settings';
import { decodeDeepSeekState } from '@/providers/deepseek/types';

describe('DeepSeek saved configuration contracts', () => {
  it('keeps native provider/model pairs distinct, including separators and escapes', () => {
    const pairs = [['a/b', 'c'], ['a', 'b/c'], ['a%2Fb', 'c'], ['供应商', '模型/?#']];
    const ids = pairs.map(([provider, model]) => encodeDeepSeekModelId(provider, model));
    expect(new Set(ids).size).toBe(4);
    pairs.forEach(([provider, model], index) => {
      expect(decodeDeepSeekModelId(ids[index])).toEqual({ provider, model });
    });
    for (const id of ['pi:a/b', 'deepseek:a', 'deepseek:/b', 'deepseek:a/%FF']) {
      expect(decodeDeepSeekModelId(id)).toBeNull();
    }
  });

  it('decodes persisted controls without enabling unsafe or malformed values', () => {
    const settings = { providerConfigs: { deepseek: {
      enabled: 'true', codeMode: 'true', cliPath: 4, presetPlugins: ['not text'],
      cliPathsByHost: { other: '/native/dsh', invalid: false },
      visibleModels: ['deepseek:a/b', 'deepseek:a/b', false, 'pi:a/b'],
    } } };
    expect(getDeepSeekProviderSettings(settings)).toMatchObject({
      enabled: false, codeMode: false, cliPath: '', presetPlugins: '',
      cliPathsByHost: { other: '/native/dsh' }, visibleModels: ['deepseek:a/b'],
    });
  });

  it('preserves explicit full-list ordering, unavailable selections and reasoning across storage', () => {
    const settings: Record<string, unknown> = { providerConfigs: { deepseek: { extensionField: 'preserve' } } };
    const models = ['first', 'second'].map(model => ({
      id: model, provider: 'native', label: model,
      encodedId: encodeDeepSeekModelId('native', model),
      reasoning: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
    }));
    const missing = encodeDeepSeekModelId('native', 'removed');
    const order = [models[1].encodedId, missing, models[0].encodedId];
    updateDeepSeekProviderSettings(settings, {
      discoveredModels: models, visibleModels: order, codeMode: true,
      preferredReasoningByModel: { [models[1].encodedId]: 'low' }, cliPath: '/custom/dsh',
    });
    const config = projectDeepSeekModelSettings(settings);
    expect(config).not.toHaveProperty('discoveredModels');
    expect(config).toMatchObject({ extensionField: 'preserve', cliPathsByHost: { [getInstallationKey()]: '/custom/dsh' } });
    const restored = { providerConfigs: { deepseek: config } };
    expect(getDeepSeekProviderSettings(restored).visibleModels).toEqual(order);
    expect(deepseekModelPolicy.getModelOptions(restored).map(row => row.value)).toEqual(order);
    expect(deepseekModelPolicy.getModelOptions(restored)[1].label).toContain('unavailable');
    expect(deepseekModelPolicy.getDefaultReasoningValue(models[1].encodedId, restored)).toBe('low');
    expect(getDeepSeekProviderSettings(restored).codeMode).toBe(true);
  });

  it('decodes only the owned store, preset and fork binding', () => {
    const initial = { schemaVersion: 1, home: '/original', profile: 'web', preset: 'claudian' } as const;
    const pending = { ...initial, preset: 'claudian-code' as const, pendingFork: { sessionId: 'source', atSeq: 19 } };
    expect(decodeDeepSeekState({ ...pending, token: 'must-not-persist' })).toEqual(pending);
    expect(() => decodeDeepSeekState({ ...initial, preset: 'standard' })).toThrow(/preset/i);
    expect(() => decodeDeepSeekState({ ...initial, schemaVersion: 2 })).toThrow(/version/i);
    expect(() => decodeDeepSeekState({ ...initial, pendingFork: { sessionId: 'source', atSeq: -1 } })).toThrow(/checkpoint/i);
  });

  it('decodes Desktop provenance and rejects an unknown profile', () => {
    const desktop = { schemaVersion: 1, home: '/native', profile: 'desktop', preset: 'claudian' };
    expect(decodeDeepSeekState(desktop)).toEqual(desktop);
    expect(() => decodeDeepSeekState({ ...desktop, profile: 'unknown' })).toThrow(/binding/);
  });
});


it('stores the WSL selection per installation and excludes derived controls from persistence', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try {
    const settings: Record<string, unknown> = {};
    updateDeepSeekProviderSettings(settings, { installationMethod: 'wsl', wslDistroOverride: ' Ubuntu ' });
    expect(getDeepSeekProviderSettings(settings)).toMatchObject({ installationMethod: 'wsl', wslDistroOverride: 'Ubuntu' });
    const stored = projectDeepSeekModelSettings(settings);
    expect(stored).toMatchObject({ installationMethodsByHost: { 'device:test': 'wsl' }, wslDistroOverridesByHost: { 'device:test': 'Ubuntu' } });
    expect(stored).not.toHaveProperty('installationMethod');
    expect(stored).not.toHaveProperty('wslDistroOverride');
  } finally { Object.defineProperty(process, 'platform', platform); }
});
