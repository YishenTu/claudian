/** @jest-environment jsdom */

import { within } from '@testing-library/dom';
import { configureAxe } from 'jest-axe';

import { chooseForkTarget } from '@/shared/modals/ForkTargetModal';

let lastModalInstance: any;
const checkAccessibility = configureAxe({
  rules: {
    region: { enabled: false },
  },
});

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian');

  class MockModal {
    app: any;
    modalEl = document.createElement('div');
    contentEl: HTMLElement;

    constructor(app: any) {
      this.app = app;
      this.contentEl = document.createElement('div');
      this.modalEl.addClass = (...classes: string[]) => this.modalEl.classList.add(...classes);
      this.contentEl.empty = () => this.contentEl.replaceChildren();
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

beforeEach(() => {
  lastModalInstance = null;
});

describe('ForkTargetModal', () => {
  const mockApp = {} as any;

  describe('chooseForkTarget', () => {
    it('should resolve "current-tab" when current tab option is clicked', async () => {
      const result = chooseForkTarget(mockApp);
      within(lastModalInstance.contentEl)
        .getByRole('button', { name: 'Current tab' })
        .click();
      expect(await result).toBe('current-tab');
    });

    it('should resolve "new-tab" when new tab option is clicked', async () => {
      const result = chooseForkTarget(mockApp);
      within(lastModalInstance.contentEl)
        .getByRole('button', { name: 'New tab' })
        .click();
      expect(await result).toBe('new-tab');
    });

    it('should resolve null when modal is closed without selection', async () => {
      const result = chooseForkTarget(mockApp);
      lastModalInstance.close();
      expect(await result).toBeNull();
    });

    it('should create two list options with correct labels', () => {
      chooseForkTarget(mockApp);
      const options = within(lastModalInstance.contentEl).getAllByRole('button');
      expect(options.map(option => option.textContent)).toEqual(['Current tab', 'New tab']);
      expect(options.every(option => option.getAttribute('type') === 'button')).toBe(true);
    });

    it('should have no automated accessibility violations', async () => {
      const result = chooseForkTarget(mockApp);

      expect(await checkAccessibility(lastModalInstance.contentEl)).toHaveNoViolations();

      lastModalInstance.close();
      await result;
    });
  });
});
