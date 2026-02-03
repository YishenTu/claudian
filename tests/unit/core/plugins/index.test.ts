import { PluginManager } from '@/core/plugins';

describe('core/plugins index', () => {
  it('re-exports runtime symbols', () => {
    expect(PluginManager).toBeDefined();
  });
});

