import { createMockEl } from '@test/helpers/mockElement';

import { chooseForkTarget } from '@/shared/modals/ForkTargetModal';

let lastModalInstance: any;

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian');

  class MockModal {
    app: any;
    modalEl: any = { addClass: jest.fn() };
    contentEl: any;

    constructor(app: any) {
      this.app = app;
      this.contentEl = createMockEl();
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      lastModalInstance = this;
    }

    setTitle = jest.fn();

    open() {
      this.onOpen();
    }

    close() {
      this.onClose();
    }

    onOpen() {
      // Overridden by subclass
    }

    onClose() {
      // Overridden by subclass
    }
  }

  return {
    ...actual,
    Modal: MockModal,
  };
});

function getOptionItems(): Array<{ text: string; click: () => void }> {
  const listEl = lastModalInstance.contentEl.children?.find(
    (c: any) => c.hasClass?.('claudian-fork-target-list'),
  );
  if (!listEl) return [];
  return (listEl.children || [])
    .filter((c: any) => c.hasClass?.('claudian-fork-target-option'))
    .map((c: any) => ({
      text: c.textContent,
      click: () => {
        const handler = c._eventListeners?.get('click')?.[0];
        handler?.();
      },
    }));
}

beforeEach(() => {
  lastModalInstance = null;
});

describe('ForkTargetModal', () => {
  const mockApp = {} as any;

  describe('chooseForkTarget', () => {
    it('should resolve "current-tab" when current tab option is clicked', async () => {
      const result = chooseForkTarget(mockApp);
      const items = getOptionItems();
      const item = items.find(i => i.text === 'Current tab');
      item!.click();
      expect(await result).toBe('current-tab');
    });

    it('should resolve "new-tab" when new tab option is clicked', async () => {
      const result = chooseForkTarget(mockApp);
      const items = getOptionItems();
      const item = items.find(i => i.text === 'New tab');
      item!.click();
      expect(await result).toBe('new-tab');
    });

    it('should resolve null when modal is closed without selection', async () => {
      const result = chooseForkTarget(mockApp);
      lastModalInstance.close();
      expect(await result).toBeNull();
    });

    it('should create two list options with correct labels', () => {
      chooseForkTarget(mockApp);
      const items = getOptionItems();
      expect(items).toHaveLength(2);
      expect(items[0].text).toBe('Current tab');
      expect(items[1].text).toBe('New tab');
    });
  });
});
