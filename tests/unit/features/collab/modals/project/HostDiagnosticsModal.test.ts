/** @jest-environment jsdom */

jest.mock('obsidian', () => ({
  Modal: class MockModal {
    readonly contentEl = document.createElement('div');
    readonly modalEl = document.createElement('div');
    close = jest.fn(() => this.onClose());
    open = jest.fn(() => this.onOpen());
    setTitle = jest.fn();
    onClose(): void {}
    onOpen(): void {}
  },
}));

import { HostDiagnosticsModal } from '@/features/collab/modals/project/HostDiagnosticsModal';

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('HostDiagnosticsModal', () => {
  it('renders and copies only the supplied redacted diagnostics', async () => {
    const copyText = jest.fn().mockResolvedValue(undefined);
    const modal = new HostDiagnosticsModal({} as never, {
      copyText,
      diagnostics: {
        error: { code: 'database-corrupt', reason: 'authority-open-failed' },
        projectId: 'project-alpha',
        status: 'needs-attention',
      },
      projectName: 'Alpha',
    });

    modal.onOpen();
    expect(modal.contentEl.textContent).toContain('database-corrupt');
    expect(modal.contentEl.textContent).toContain('authority-open-failed');
    modal.contentEl.querySelector<HTMLButtonElement>(
      '[data-action="copy-host-diagnostics"]',
    )?.click();
    await flush();
    expect(copyText).toHaveBeenCalledWith(expect.stringContaining('database-corrupt'));
  });
});
