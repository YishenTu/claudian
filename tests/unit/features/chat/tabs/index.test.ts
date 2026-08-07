import { TabBar } from '@/features/chat/tabs/TabBar';
import { TabManager } from '@/features/chat/tabs/TabManager';
import { createTabRuntime } from '@/features/chat/tabs/TabRuntimeFactory';

describe('features/chat/tabs index', () => {
  it('re-exports runtime symbols', () => {
    expect(createTabRuntime).toBeDefined();
    expect(TabBar).toBeDefined();
    expect(TabManager).toBeDefined();
  });
});
