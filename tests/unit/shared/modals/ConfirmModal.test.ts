import { createMockEl } from '@test/helpers/mockElement';

let lastModalInstance: any;
let createdButtons: any[] = [];

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian');

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

  class MockSetting {
    constructor(_containerEl: any) {}

    addButton(cb: (btn: any) => void) {
      const btn: any = {
        _onClick: null as null | (() => void),
        setButtonText: jest.fn().mockReturnThis(),
        setWarning: jest.fn().mockReturnThis(),
        onClick: jest.fn((handler: () => void) => {
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

