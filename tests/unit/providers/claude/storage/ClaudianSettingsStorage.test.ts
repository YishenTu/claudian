import '@/providers';

import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import { getClaudeProviderSettings } from '@/providers/claude/settings';
import {
  CLAUDIAN_SETTINGS_PATH,
  ClaudianSettingsStorage,
} from '@/providers/claude/storage/ClaudianSettingsStorage';
import { DEFAULT_SETTINGS } from '@/providers/claude/types/settings';
import { getCodexProviderSettings } from '@/providers/codex/settings';

const mockAdapter = {
  exists: jest.fn(),
  read: jest.fn(),
  write: jest.fn(),
} as unknown as jest.Mocked<VaultFileAdapter>;

describe('ClaudianSettingsStorage', () => {
  let storage: ClaudianSettingsStorage;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset mock implementations to default resolved values
    mockAdapter.exists.mockResolvedValue(false);
    mockAdapter.read.mockResolvedValue('{}');
    mockAdapter.write.mockResolvedValue(undefined);
    storage = new ClaudianSettingsStorage(mockAdapter);
  });

  describe('load', () => {
    it('should return defaults when file does not exist', async () => {
      mockAdapter.exists.mockResolvedValue(false);

      const result = await storage.load();

      expect(result.model).toBe(DEFAULT_SETTINGS.model);
      expect(result.thinkingBudget).toBe(DEFAULT_SETTINGS.thinkingBudget);
      expect(result.permissionMode).toBe(DEFAULT_SETTINGS.permissionMode);
      expect(mockAdapter.read).not.toHaveBeenCalled();
    });

    it('should parse valid JSON and merge with defaults', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        model: 'claude-opus-4-5',
        userName: 'TestUser',
      }));

      const result = await storage.load();

      expect(result.model).toBe('claude-opus-4-5');
      expect(result.userName).toBe('TestUser');
      // Defaults should still be present for unspecified fields
      expect(result.thinkingBudget).toBe(DEFAULT_SETTINGS.thinkingBudget);
    });

    it('should strip legacy blocklist fields from loaded data', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        enableBlocklist: false,
        blockedCommands: {
          unix: ['custom-unix-cmd'],
          windows: ['custom-win-cmd'],
        },
      }));

      const result = await storage.load();
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect('enableBlocklist' in result).toBe(false);
      expect('blockedCommands' in result).toBe(false);
      expect(writtenContent).not.toHaveProperty('enableBlocklist');
      expect(writtenContent).not.toHaveProperty('blockedCommands');
    });

    it('should normalize claudeCliPathsByHost from loaded data', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        claudeCliPathsByHost: {
          'host-a': '/custom/path-a',
          'host-b': '/custom/path-b',
        },
      }));

      const result = await storage.load();

      expect(getClaudeProviderSettings(result).cliPathsByHost['host-a']).toBe('/custom/path-a');
      expect(getClaudeProviderSettings(result).cliPathsByHost['host-b']).toBe('/custom/path-b');
    });

    it('should preserve legacy claudeCliPath field', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        claudeCliPath: '/legacy/path',
      }));

      const result = await storage.load();

      expect(getClaudeProviderSettings(result).cliPath).toBe('/legacy/path');
    });

    it('should normalize codexCliPathsByHost from loaded data', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        codexCliPathsByHost: {
          'host-a': '/custom/codex-a',
          'host-b': '/custom/codex-b',
        },
      }));

      const result = await storage.load();

      expect(getCodexProviderSettings(result).cliPathsByHost['host-a']).toBe('/custom/codex-a');
      expect(getCodexProviderSettings(result).cliPathsByHost['host-b']).toBe('/custom/codex-b');
    });

    it('should preserve legacy codexCliPath field', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        codexCliPath: '/legacy/codex',
      }));

      const result = await storage.load();

      expect(getCodexProviderSettings(result).cliPath).toBe('/legacy/codex');
    });

    it('should remove legacy show1MModel from the stored file', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        model: 'sonnet',
        show1MModel: true,
      }));

      const result = await storage.load();
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect(getClaudeProviderSettings(result).enableSonnet1M).toBe(
        getClaudeProviderSettings(DEFAULT_SETTINGS).enableSonnet1M,
      );
      expect(writtenContent.model).toBe('sonnet');
      expect(writtenContent.hiddenProviderCommands).toEqual({});
      expect(writtenContent).not.toHaveProperty('show1MModel');
    });

    it('should remove legacy slashCommands from the stored file', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        model: 'sonnet',
        slashCommands: [{ id: 'cmd-review', name: 'review', content: 'Review' }],
      }));

      const result = await storage.load();
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect('slashCommands' in result).toBe(false);
      expect(writtenContent.model).toBe('sonnet');
      expect(writtenContent.hiddenProviderCommands).toEqual({});
      expect(writtenContent).not.toHaveProperty('slashCommands');
    });

    it('should migrate legacy hiddenSlashCommands into Claude hiddenProviderCommands', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        hiddenSlashCommands: ['commit', '/review'],
      }));

      const result = await storage.load();
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect(result.hiddenProviderCommands).toEqual({
        claude: ['commit', 'review'],
      });
      expect(writtenContent.hiddenProviderCommands).toEqual({
        claude: ['commit', 'review'],
      });
    });

    it('should not override explicit provider hidden commands with legacy hiddenSlashCommands', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        hiddenProviderCommands: {
          claude: ['existing'],
        },
        hiddenSlashCommands: ['commit', '/review'],
      }));

      const result = await storage.load();
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect(result.hiddenProviderCommands).toEqual({
        claude: ['existing'],
      });
      expect(writtenContent.hiddenProviderCommands).toEqual({
        claude: ['existing'],
      });
    });

    it('normalizes stale scoped mixed env snippets back to unscoped on load', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        envSnippets: [{
          id: 'snippet-1',
          name: 'Mixed snippet',
          description: '',
          envVars: 'PATH=/usr/local/bin\nANTHROPIC_MODEL=claude-custom',
          scope: 'shared',
        }],
      }));

      const result = await storage.load();
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);

      expect(result.envSnippets).toEqual([{
        id: 'snippet-1',
        name: 'Mixed snippet',
        description: '',
        envVars: 'PATH=/usr/local/bin\nANTHROPIC_MODEL=claude-custom',
        scope: undefined,
        contextLimits: undefined,
      }]);
      expect(writtenContent.envSnippets[0].scope).toBeUndefined();
    });

    it('should throw on JSON parse error', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue('invalid json');

      await expect(storage.load()).rejects.toThrow();
    });

    it('should throw on read error', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockRejectedValue(new Error('Read failed'));

      await expect(storage.load()).rejects.toThrow('Read failed');
    });
  });

  describe('save', () => {
    it('should write settings to file', async () => {
      const settings = {
        ...DEFAULT_SETTINGS,
        model: 'claude-opus-4-5' as const,
      };

      await storage.save(settings);

      expect(mockAdapter.write).toHaveBeenCalledWith(
        CLAUDIAN_SETTINGS_PATH,
        expect.any(String)
      );
      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);
      expect(writtenContent.model).toBe('claude-opus-4-5');
    });

    it('should strip legacy slashCommands before writing', async () => {
      const settings = {
        ...DEFAULT_SETTINGS,
        model: 'claude-opus-4-5' as const,
        slashCommands: [{ id: 'cmd-review', name: 'review', content: 'Review' }],
      } as typeof DEFAULT_SETTINGS & { slashCommands: unknown[] };

      await storage.save(settings as any);

      const writtenContent = JSON.parse(mockAdapter.write.mock.calls[0][1]);
      expect(writtenContent.model).toBe('claude-opus-4-5');
      expect(writtenContent).not.toHaveProperty('slashCommands');
    });

    it('should throw on write error', async () => {
      mockAdapter.write.mockRejectedValue(new Error('Write failed'));

      await expect(storage.save(DEFAULT_SETTINGS)).rejects.toThrow('Write failed');
    });
  });

  describe('exists', () => {
    it('should return true when file exists', async () => {
      mockAdapter.exists.mockResolvedValue(true);

      const result = await storage.exists();

      expect(result).toBe(true);
      expect(mockAdapter.exists).toHaveBeenCalledWith(CLAUDIAN_SETTINGS_PATH);
    });

    it('should return false when file does not exist', async () => {
      mockAdapter.exists.mockResolvedValue(false);

      const result = await storage.exists();

      expect(result).toBe(false);
    });
  });

  describe('update', () => {
    it('should merge updates with existing settings', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({
        model: 'claude-haiku-4-5',
        userName: 'ExistingUser',
      }));

      await storage.update({ model: 'claude-opus-4-5' });

      const writeCall = mockAdapter.write.mock.calls[0];
      const writtenContent = JSON.parse(writeCall[1]);
      expect(writtenContent.model).toBe('claude-opus-4-5');
      expect(writtenContent.userName).toBe('ExistingUser');
    });
  });

  describe('setLastModel', () => {
    it('should update lastClaudeModel for non-custom models', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({}));

      await storage.setLastModel('claude-sonnet-4-5', false);

      const writeCall = mockAdapter.write.mock.calls[0];
      const writtenContent = JSON.parse(writeCall[1]);
      expect(writtenContent.providerConfigs.claude.lastModel).toBe('claude-sonnet-4-5');
      // lastCustomModel keeps its default value (empty string)
    });

    it('should update lastCustomModel for custom models', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({}));

      await storage.setLastModel('custom-model-id', true);

      const writeCall = mockAdapter.write.mock.calls[0];
      const writtenContent = JSON.parse(writeCall[1]);
      expect(writtenContent.lastCustomModel).toBe('custom-model-id');
      // lastClaudeModel keeps its default value
    });
  });

  describe('setLastEnvHash', () => {
    it('should update environment hash', async () => {
      mockAdapter.exists.mockResolvedValue(true);
      mockAdapter.read.mockResolvedValue(JSON.stringify({}));

      await storage.setLastEnvHash('abc123');

      const writeCall = mockAdapter.write.mock.calls[0];
      const writtenContent = JSON.parse(writeCall[1]);
      expect(writtenContent.providerConfigs.claude.environmentHash).toBe('abc123');
    });
  });
});
