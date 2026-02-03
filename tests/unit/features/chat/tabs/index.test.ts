import { TabBar, TabManager, createTab } from '@/features/chat/tabs';

describe('features/chat/tabs index', () => {
  it('re-exports runtime symbols', () => {
    expect(createTab).toBeDefined();
    expect(TabBar).toBeDefined();
    expect(TabManager).toBeDefined();
  });
});
