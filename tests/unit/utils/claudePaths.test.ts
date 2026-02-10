import * as os from 'os';
import * as path from 'path';

import {
  getClaudeHomeDirName,
  getGlobalClaudeHome,
  getGlobalClaudePath,
  getVaultClaudeDir,
  getVaultClaudePath,
  setClaudeHomeDirName,
} from '@/utils/claudePaths';

describe('claudePaths', () => {
  afterEach(() => {
    // Reset to default after each test
    setClaudeHomeDirName('.claude');
  });

  describe('setClaudeHomeDirName / getClaudeHomeDirName', () => {
    it('defaults to .claude', () => {
      expect(getClaudeHomeDirName()).toBe('.claude');
    });

    it('can be set to a custom value', () => {
      setClaudeHomeDirName('.claude-internal');
      expect(getClaudeHomeDirName()).toBe('.claude-internal');
    });
  });

  describe('getGlobalClaudeHome', () => {
    it('returns ~/.claude by default', () => {
      expect(getGlobalClaudeHome()).toBe(path.join(os.homedir(), '.claude'));
    });

    it('returns ~/.claude-internal when configured', () => {
      setClaudeHomeDirName('.claude-internal');
      expect(getGlobalClaudeHome()).toBe(path.join(os.homedir(), '.claude-internal'));
    });
  });

  describe('getGlobalClaudePath', () => {
    it('joins segments under global home', () => {
      expect(getGlobalClaudePath('projects')).toBe(
        path.join(os.homedir(), '.claude', 'projects')
      );
    });

    it('handles multiple segments', () => {
      expect(getGlobalClaudePath('plugins', 'installed_plugins.json')).toBe(
        path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json')
      );
    });

    it('uses custom dir name', () => {
      setClaudeHomeDirName('.claude-internal');
      expect(getGlobalClaudePath('agents')).toBe(
        path.join(os.homedir(), '.claude-internal', 'agents')
      );
    });
  });

  describe('getVaultClaudeDir', () => {
    it('returns .claude by default', () => {
      expect(getVaultClaudeDir()).toBe('.claude');
    });

    it('returns custom name when configured', () => {
      setClaudeHomeDirName('.claude-internal');
      expect(getVaultClaudeDir()).toBe('.claude-internal');
    });
  });

  describe('getVaultClaudePath', () => {
    it('returns vault-relative path', () => {
      expect(getVaultClaudePath('settings.json')).toBe('.claude/settings.json');
    });

    it('handles multiple segments', () => {
      expect(getVaultClaudePath('sessions', 'abc.jsonl')).toBe('.claude/sessions/abc.jsonl');
    });

    it('uses custom dir name', () => {
      setClaudeHomeDirName('.claude-internal');
      expect(getVaultClaudePath('settings.json')).toBe('.claude-internal/settings.json');
    });
  });

  describe('dynamic path functions in storage modules', () => {
    it('getCCSettingsPath responds to dir name changes', async () => {
      const { getCCSettingsPath } = await import('@/core/storage/CCSettingsStorage');
      expect(getCCSettingsPath()).toBe('.claude/settings.json');

      setClaudeHomeDirName('.claude-internal');
      expect(getCCSettingsPath()).toBe('.claude-internal/settings.json');
    });

    it('getSessionsPath responds to dir name changes', async () => {
      const { getSessionsPath } = await import('@/core/storage/SessionStorage');
      expect(getSessionsPath()).toBe('.claude/sessions');

      setClaudeHomeDirName('.claude-internal');
      expect(getSessionsPath()).toBe('.claude-internal/sessions');
    });

    it('getSDKProjectsPath responds to dir name changes', async () => {
      const { getSDKProjectsPath } = await import('@/utils/sdkSession');
      expect(getSDKProjectsPath()).toBe(path.join(os.homedir(), '.claude', 'projects'));

      setClaudeHomeDirName('.claude-internal');
      expect(getSDKProjectsPath()).toBe(path.join(os.homedir(), '.claude-internal', 'projects'));
    });
  });
});
