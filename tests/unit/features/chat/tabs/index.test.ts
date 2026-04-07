import { createTab } from '@/features/chat/tabs/Tab';
import { TabBar } from '@/features/chat/tabs/TabBar';
import { TabManager } from '@/features/chat/tabs/TabManager';

describe('features/chat/tabs index', () => {
  it('re-exports runtime symbols', () => {
    expect(createTab).toBeDefined();
    expect(TabBar).toBeDefined();
    expect(TabManager).toBeDefined();
  });
});
