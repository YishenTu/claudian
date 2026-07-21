import { BUILT_IN_PROVIDER_MODULES } from '@/providers';

describe('built-in ProviderModule catalog', () => {
  it('is the single ordered source for chat, workspace, and settings composition', () => {
    expect(BUILT_IN_PROVIDER_MODULES.map(module => module.id)).toEqual([
      'claude',
      'codex',
      'grok',
      'opencode',
      'pi',
    ]);
    for (const module of BUILT_IN_PROVIDER_MODULES) {
      expect(module.workspace.initialize).toEqual(expect.any(Function));
      expect(module.settingsStorage.normalizeStored).toEqual(expect.any(Function));
    }
  });
});
