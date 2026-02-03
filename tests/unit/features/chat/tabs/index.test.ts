import { createTab,TabBar, TabManager } from '@/features/chat/tabs';

describe('features/chat/tabs index', () => {
  it('re-exports runtime symbols', () => {
    expect(createTab).toBeDefined();
    expect(TabBar).toBeDefined();
    expect(TabManager).toBeDefined();
  });
});
