import { getCodexModelOptions } from '@/providers/codex/modelOptions';
import type { CodexDiscoveredModel } from '@/providers/codex/models';
import { getCodexProviderSettings, updateCodexProviderSettings } from '@/providers/codex/settings';

const discoveredModels: CodexDiscoveredModel[] = [
  ['constructor', 'Constructor Model'],
  ['toString', 'String Model'],
  ['__proto__', 'Proto Model'],
].map(([model, displayName]) => ({
  model,
  displayName,
  description: '',
  supportedReasoningEfforts: [{ value: 'high', description: 'High' }],
  defaultReasoningEffort: 'high',
  serviceTiers: [],
  defaultServiceTier: null,
  inputModalities: ['text'],
  isDefault: false,
}));

describe('Codex model options', () => {
  it('uses discovered labels for prototype-named models without own aliases', () => {
    const settings: Record<string, unknown> = {};
    updateCodexProviderSettings(settings, {
      discoveredModels,
      visibleModels: ['toString', '__proto__', 'constructor'],
    });

    const reloaded = JSON.parse(JSON.stringify(settings));
    expect(getCodexProviderSettings(reloaded).discoveredModels.map(model => model.model))
      .toEqual(['constructor', 'toString', '__proto__']);
    expect(getCodexModelOptions(getCodexProviderSettings(reloaded))).toEqual([
      { value: 'openai-codex/toString', label: 'String Model', description: undefined },
      { value: 'openai-codex/__proto__', label: 'Proto Model', description: undefined },
      { value: 'openai-codex/constructor', label: 'Constructor Model', description: undefined },
    ]);
  });

  it('projects own aliases after serialization, unrelated updates and visibility pruning', () => {
    const settings: Record<string, unknown> = {};
    updateCodexProviderSettings(settings, {
      discoveredModels,
      visibleModels: ['toString', '__proto__', 'constructor'],
      modelAliases: JSON.parse('{"__proto__":" Custom Proto ","constructor":"Custom Constructor","toString":"Custom String","unselected":"Unused"}'),
    });
    updateCodexProviderSettings(settings, { safeMode: 'read-only' });

    const reloaded = JSON.parse(JSON.stringify(settings));
    const aliases = getCodexProviderSettings(reloaded).modelAliases;
    expect(Object.keys(aliases)).toEqual(['__proto__', 'constructor', 'toString']);
    expect(aliases['__proto__']).toBe('Custom Proto');
    expect(getCodexModelOptions(getCodexProviderSettings(reloaded))).toEqual([
      { value: 'openai-codex/toString', label: 'Custom String', description: undefined },
      { value: 'openai-codex/__proto__', label: 'Custom Proto', description: undefined },
      { value: 'openai-codex/constructor', label: 'Custom Constructor', description: undefined },
    ]);

    updateCodexProviderSettings(reloaded, { visibleModels: ['__proto__', 'toString'] });
    const pruned = JSON.parse(JSON.stringify(reloaded));
    expect(Object.keys(getCodexProviderSettings(pruned).modelAliases)).toEqual(['__proto__', 'toString']);
    expect(getCodexModelOptions(getCodexProviderSettings(pruned))).toEqual([
      { value: 'openai-codex/__proto__', label: 'Custom Proto', description: undefined },
      { value: 'openai-codex/toString', label: 'Custom String', description: undefined },
    ]);
  });
});
