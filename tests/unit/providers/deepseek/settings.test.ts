import { deepseekModelPolicy } from '@/providers/deepseek/DeepSeekModelPolicy';
import { decodeDeepSeekModelId, encodeDeepSeekModelId } from '@/providers/deepseek/models';
import {
  getDeepSeekProviderSettings,
  projectDeepSeekModelSettings,
  updateDeepSeekProviderSettings,
} from '@/providers/deepseek/settings';
import { bindDeepSeekState, decodeDeepSeekState } from '@/providers/deepseek/types';

jest.mock('@/core/device/InstallationKey', () => ({ getInstallationKey: () => 'device:test' }));

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
      enabled: 'true', codeMode: 'true', cliPath: 4,
      cliPathsByHost: { other: '/native/dsh', invalid: false },
      visibleModels: ['deepseek:a/b', 'deepseek:a/b', false, 'pi:a/b'],
    } } };
    expect(getDeepSeekProviderSettings(settings)).toMatchObject({
      enabled: false, codeMode: false, cliPath: '',
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
    expect(config).toMatchObject({ extensionField: 'preserve', cliPathsByHost: { 'device:test': '/custom/dsh' } });
    const restored = { providerConfigs: { deepseek: config } };
    expect(getDeepSeekProviderSettings(restored).visibleModels).toEqual(order);
    expect(deepseekModelPolicy.getModelOptions(restored).map(row => row.value)).toEqual(order);
    expect(deepseekModelPolicy.getModelOptions(restored)[1].label).toContain('unavailable');
    expect(deepseekModelPolicy.getDefaultReasoningValue(models[1].encodedId, restored)).toBe('low');
    expect(getDeepSeekProviderSettings(restored).codeMode).toBe(true);
  });

  it('pins the preset and store at binding and preserves them for resume/forks', () => {
    const initial = bindDeepSeekState(undefined, { home: '/original', codeMode: true });
    expect(initial).toEqual({ schemaVersion: 1, home: '/original', profile: 'web', preset: 'claudian-code' });
    const pending = { ...initial, pendingFork: { sessionId: 'source', atSeq: 19 } };
    expect(bindDeepSeekState(pending, { home: '/new-default', codeMode: false })).toEqual(pending);
    expect(decodeDeepSeekState({ ...pending, token: 'must-not-persist' })).toEqual(pending);
    expect(() => decodeDeepSeekState({ ...initial, preset: 'standard' })).toThrow(/preset/i);
    expect(() => decodeDeepSeekState({ ...initial, schemaVersion: 2 })).toThrow(/version/i);
    expect(() => decodeDeepSeekState({ ...initial, pendingFork: { sessionId: 'source', atSeq: -1 } })).toThrow(/checkpoint/i);
  });
});
