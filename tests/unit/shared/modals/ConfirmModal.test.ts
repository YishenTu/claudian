import { createMockEl } from '@test/helpers/MockElement';

let lastModalInstance: any;
let createdButtons: any[] = [];

vi.mock('obsidian', async () => {
  const actual = (await vi.importActual<typeof import('obsidian')>('obsidian'));

  class MockModal {
    app: any;
    modalEl: any;
    contentEl: any;

    constructor(app: any) {
      this.app = app;
      this.modalEl = createMockEl();
      this.contentEl = createMockEl();
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      lastModalInstance = this;
    }

    setTitle = vi.fn();

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

  class MockSetting {
    constructor(_containerEl: any) {}

    addButton(cb: (btn: any) => void) {
      const btn: any = {
        _onClick: null as null | (() => void),
        setButtonText: vi.fn().mockReturnThis(),
        setDestructive: vi.fn().mockReturnThis(),
        setWarning: vi.fn().mockReturnThis(),
        onClick: vi.fn((handler: () => void) => {
          btn._onClick = handler;
          return btn;
        }),
      };
      createdButtons.push(btn);
      cb(btn);
      return this;
    }
  }

  return {
    ...actual,
    Modal: MockModal,
    Setting: MockSetting,
  };
});

import { confirm, confirmDelete } from '@/shared/modals/ConfirmModal';

beforeEach(() => {
  lastModalInstance = null;
  createdButtons = [];
});

describe('ConfirmModal', () => {
  const mockApp = {} as any;

  it('confirmDelete resolves true when confirm button is clicked', async () => {
    const p = confirmDelete(mockApp, 'Are you sure?');

    expect(lastModalInstance).toBeTruthy();
    expect(createdButtons).toHaveLength(2);

    const confirmBtn = createdButtons[1];
    expect(confirmBtn.setDestructive).toHaveBeenCalledTimes(1);
    confirmBtn._onClick();

    await expect(p).resolves.toBe(true);
    expect(lastModalInstance.contentEl.children).toHaveLength(0);
  });

  it('confirmDelete resolves false when closed without confirming', async () => {
    const p = confirmDelete(mockApp, 'Are you sure?');

    lastModalInstance.close();

    await expect(p).resolves.toBe(false);
    expect(lastModalInstance.contentEl.children).toHaveLength(0);
  });

  it('confirm resolves true when confirm button is clicked', async () => {
    const p = confirm(mockApp, 'Proceed?', 'Confirm');

    expect(createdButtons).toHaveLength(2);
    const confirmBtn = createdButtons[1];
    expect(confirmBtn.setButtonText).toHaveBeenLastCalledWith('Confirm');

    confirmBtn._onClick();

    await expect(p).resolves.toBe(true);
  });
});
