/** @jest-environment jsdom */

import {
  getGitInstallSupport,
  GitSetupPanel,
  type GitSetupResolution,
} from '@/features/collab/sidebar/GitSetupPanel';

const AVAILABLE: GitSetupResolution = {
  status: 'available',
  version: '2.45.1',
};

describe('GitSetupPanel', () => {
  it('shows install help and transitions to ready after Rescan', async () => {
    const container = document.createElement('div');
    const onRescan = jest.fn().mockResolvedValue(AVAILABLE);
    const panel = new GitSetupPanel(container, {
      configuredPath: '',
      onRescan,
      onSaveConfiguredPath: jest.fn(),
      platform: 'win32',
      resolution: { status: 'missing' },
    });

    panel.render();

    expect(container.querySelector<HTMLAnchorElement>('.claudian-collab-git-guide')?.href)
      .toBe('https://git-scm.com/download/win');
    expect(container.querySelector<HTMLTextAreaElement>('.claudian-collab-git-prompt')?.value)
      .toContain('not WSL');
    container.querySelector<HTMLButtonElement>('[data-action="rescan"]')?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(onRescan).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('2.45.1');
    expect(container.querySelector('.claudian-collab-git-guide')).toBeNull();
  });

  it('copies the agent prompt and saves a trimmed advanced path', async () => {
    const container = document.createElement('div');
    const copyText = jest.fn().mockResolvedValue(undefined);
    const onSaveConfiguredPath = jest.fn().mockResolvedValue(undefined);
    const panel = new GitSetupPanel(container, {
      configuredPath: '',
      copyText,
      onRescan: jest.fn(),
      onSaveConfiguredPath,
      platform: 'darwin',
      resolution: { status: 'missing' },
    });
    panel.render();

    container.querySelector<HTMLButtonElement>('[data-action="copy-prompt"]')?.click();
    const input = container.querySelector<HTMLInputElement>('.claudian-collab-git-path')!;
    input.value = '  /opt/homebrew/bin/git  ';
    container.querySelector<HTMLButtonElement>('[data-action="save-path"]')?.click();
    await Promise.resolve();

    expect(copyText).toHaveBeenCalledWith(expect.stringContaining('Git 2.38'));
    expect(onSaveConfiguredPath).toHaveBeenCalledWith('/opt/homebrew/bin/git');
  });

  it('provides platform-specific official guidance without an installer action', () => {
    expect(getGitInstallSupport('darwin').guideUrl).toBe('https://git-scm.com/download/mac');
    expect(getGitInstallSupport('linux').guideUrl).toBe('https://git-scm.com/download/linux');
    expect(getGitInstallSupport('win32').agentPrompt).toContain('Git for Windows');
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const prompt = getGitInstallSupport(platform).agentPrompt;
      expect(prompt).toContain('ask me to confirm');
      expect(prompt).toContain('global Git identity or credential');
    }
  });
});
