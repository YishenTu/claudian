import {
  CLAUDIAN_SETTINGS_PATH,
  ClaudianSettingsStorage,
  normalizeBlockedCommands,
} from '@/core/storage/ClaudianSettingsStorage';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import { DEFAULT_SETTINGS, getDefaultBlockedCommands } from '@/core/types';

// Mock VaultFileAdapter
const mockAdapter = {
  exists: jest.fn(),
  read: jest.fn(),
  write: jest.fn(),
} as unknown as VaultFileAdapter;

describe('ClaudianSettingsStorage', () => {
  let storage: ClaudianSettingsStorage;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset mock implementations to default resolved values
    (mockAdapter.exists as jest.Mock).mockResolvedValue(false);
    (mockAdapter.read as jest.Mock).mockResolvedValue('{}');
    (mockAdapter.write as jest.Mock).mockResolvedValue(undefined);
    storage = new ClaudianSettingsStorage(mockAdapter);
  });

  describe('load', () => {
    it('should return defaults when file does not exist', async () => {
      (mockAdapter.exists as jest.Mock).mockResolvedValue(false);

      const result = await storage.load();

      expect(result.model).toBe(DEFAULT_SETTINGS.model);
      expect(result.thinkingBudget).toBe(DEFAULT_SETTINGS.thinkingBudget);
      expect(result.permissionMode).toBe(DEFAULT_SETTINGS.permissionMode);
      expect(mockAdapter.read).not.toHaveBeenCalled();
    });

    it('should parse valid JSON and merge with defaults', async () => {
      (mockAdapter.exists as jest.Mock).mockResolvedValue(true);
      (mockAdapter.read as jest.Mock).mockResolvedValue(JSON.stringify({
        model: 'claude-opus-4-5',
        userName: 'TestUser',
      }));

      const result = await storage.load();

      expect(result.model).toBe('claude-opus-4-5');
      expect(result.userName).toBe('TestUser');
      // Defaults should still be present for unspecified fields
      expect(result.thinkingBudget).toBe(DEFAULT_SETTINGS.thinkingBudget);
    });

    it('should normalize blockedCommands from loaded data', async () => {
      (mockAdapter.exists as jest.Mock).mockResolvedValue(true);
      (mockAdapter.read as jest.Mock).mockResolvedValue(JSON.stringify({
        blockedCommands: {
          unix: ['custom-unix-cmd'],
          windows: ['custom-win-cmd'],
        },
      }));

      const result = await storage.load();

      expect(result.blockedCommands.unix).toContain('custom-unix-cmd');
      expect(result.blockedCommands.windows).toContain('custom-win-cmd');
    });

    it('should normalize claudeCliPathsByHost from loaded data', async () => {
      (mockAdapter.exists as jest.Mock).mockResolvedValue(true);
      (mockAdapter.read as jest.Mock).mockResolvedValue(JSON.stringify({
        claudeCliPathsByHost: {
          'host-a': '/custom/path-a',
          'host-b': '/custom/path-b',
        },
      }));

      const result = await storage.load();

      expect(result.claudeCliPathsByHost['host-a']).toBe('/custom/path-a');
      expect(result.claudeCliPathsByHost['host-b']).toBe('/custom/path-b');
    });

    it('should preserve legacy claudeCliPath field', async () => {
      (mockAdapter.exists as jest.Mock).mockResolvedValue(true);
      (mockAdapter.read as jest.Mock).mockResolvedValue(JSON.stringify({
        claudeCliPath: '/legacy/path',
      }));

      const result = await storage.load();

      expect(result.claudeCliPath).toBe('/legacy/path');
    });

    it('should throw on JSON parse error', async () => {
      (mockAdapter.exists as jest.Mock).mockResolvedValue(true);
      (mockAdapter.read as jest.Mock).mockResolvedValue('invalid json');

      await expect(storage.load()).rejects.toThrow();
    });

    it('should throw on read error', async () => {
      (mockAdapter.exists as jest.Mock).mockResolvedValue(true);
      (mockAdapter.read as jest.Mock).mockRejectedValue(new Error('Read failed'));

      await expect(storage.load()).rejects.toThrow('Read failed');
    });
  });

  describe('save', () => {
    it('should write settings to file', async () => {
      const settings = {
        ...DEFAULT_SETTINGS,
        model: 'claude-opus-4-5' as const,
      };
      // Remove slashCommands as it's stored separately
      const { slashCommands: _, ...storedSettings } = settings;

      await storage.save(storedSettings);

      expect(mockAdapter.write).toHaveBeenCalledWith(
        CLAUDIAN_SETTINGS_PATH,
        expect.any(String)
      );
      const writtenContent = JSON.parse((mockAdapter.write as jest.Mock).mock.calls[0][1]);
      expect(writtenContent.model).toBe('claude-opus-4-5');
    });

    it('should throw on write error', async () => {
      (mockAdapter.write as jest.Mock).mockRejectedValue(new Error('Write failed'));

      const settings = {
        ...DEFAULT_SETTINGS,
      };
      const { slashCommands: _, ...storedSettings } = settings;

      await expect(storage.save(storedSettings)).rejects.toThrow('Write failed');
    });
  });

  describe('exists', () => {
    it('should return true when file exists', async () => {
      (mockAdapter.exists as jest.Mock).mockResolvedValue(true);

      const result = await storage.exists();

      expect(result).toBe(true);
      expect(mockAdapter.exists).toHaveBeenCalledWith(CLAUDIAN_SETTINGS_PATH);
    });

    it('should return false when file does not exist', async () => {
      (mockAdapter.exists as jest.Mock).mockResolvedValue(false);

      const result = await storage.exists();

      expect(result).toBe(false);
    });
  });

  describe('update', () => {
    it('should merge updates with existing settings', async () => {
      (mockAdapter.exists as jest.Mock).mockResolvedValue(true);
      (mockAdapter.read as jest.Mock).mockResolvedValue(JSON.stringify({
        model: 'claude-haiku-4-5',
        userName: 'ExistingUser',
      }));

      await storage.update({ model: 'claude-opus-4-5' });

      const writeCall = (mockAdapter.write as jest.Mock).mock.calls[0];
      const writtenContent = JSON.parse(writeCall[1]);
      expect(writtenContent.model).toBe('claude-opus-4-5');
      expect(writtenContent.userName).toBe('ExistingUser');
    });
  });

  describe('legacy activeConversationId', () => {
    it('should read legacy activeConversationId when present', async () => {
      (mockAdapter.exists as jest.Mock).mockResolvedValue(true);
      (mockAdapter.read as jest.Mock).mockResolvedValue(JSON.stringify({
        activeConversationId: 'conv-123',
      }));

      const legacyId = await storage.getLegacyActiveConversationId();

      expect(legacyId).toBe('conv-123');
    });

    it('should return null when legacy activeConversationId is missing', async () => {
      (mockAdapter.exists as jest.Mock).mockResolvedValue(true);
      (mockAdapter.read as jest.Mock).mockResolvedValue(JSON.stringify({
        model: 'claude-haiku-4-5',
      }));

      const legacyId = await storage.getLegacyActiveConversationId();

      expect(legacyId).toBeNull();
    });

    it('should clear legacy activeConversationId from file', async () => {
      (mockAdapter.exists as jest.Mock).mockResolvedValue(true);
      (mockAdapter.read as jest.Mock).mockResolvedValue(JSON.stringify({
        activeConversationId: 'conv-123',
        model: 'claude-haiku-4-5',
      }));

      await storage.clearLegacyActiveConversationId();

      const writeCall = (mockAdapter.write as jest.Mock).mock.calls[0];
      const writtenContent = JSON.parse(writeCall[1]);
      expect(writtenContent.activeConversationId).toBeUndefined();
      expect(writtenContent.model).toBe('claude-haiku-4-5');
    });
  });

  describe('setLastModel', () => {
    it('should update lastClaudeModel for non-custom models', async () => {
      (mockAdapter.exists as jest.Mock).mockResolvedValue(true);
      (mockAdapter.read as jest.Mock).mockResolvedValue(JSON.stringify({}));

      await storage.setLastModel('claude-sonnet-4-5', false);

      const writeCall = (mockAdapter.write as jest.Mock).mock.calls[0];
      const writtenContent = JSON.parse(writeCall[1]);
      expect(writtenContent.lastClaudeModel).toBe('claude-sonnet-4-5');
      // lastCustomModel keeps its default value (empty string)
    });

    it('should update lastCustomModel for custom models', async () => {
      (mockAdapter.exists as jest.Mock).mockResolvedValue(true);
      (mockAdapter.read as jest.Mock).mockResolvedValue(JSON.stringify({}));

      await storage.setLastModel('custom-model-id', true);

      const writeCall = (mockAdapter.write as jest.Mock).mock.calls[0];
      const writtenContent = JSON.parse(writeCall[1]);
      expect(writtenContent.lastCustomModel).toBe('custom-model-id');
      // lastClaudeModel keeps its default value
    });
  });

  describe('setLastEnvHash', () => {
    it('should update environment hash', async () => {
      (mockAdapter.exists as jest.Mock).mockResolvedValue(true);
      (mockAdapter.read as jest.Mock).mockResolvedValue(JSON.stringify({}));

      await storage.setLastEnvHash('abc123');

      const writeCall = (mockAdapter.write as jest.Mock).mock.calls[0];
      const writtenContent = JSON.parse(writeCall[1]);
      expect(writtenContent.lastEnvHash).toBe('abc123');
    });
  });
});

describe('normalizeBlockedCommands', () => {
  const defaults = getDefaultBlockedCommands();

  it('should return defaults for null input', () => {
    const result = normalizeBlockedCommands(null);

    expect(result.unix).toEqual(defaults.unix);
    expect(result.windows).toEqual(defaults.windows);
  });

  it('should return defaults for undefined input', () => {
    const result = normalizeBlockedCommands(undefined);

    expect(result.unix).toEqual(defaults.unix);
    expect(result.windows).toEqual(defaults.windows);
  });

  it('should migrate old string[] format to platform-keyed structure', () => {
    const oldFormat = ['custom-cmd-1', 'custom-cmd-2'];

    const result = normalizeBlockedCommands(oldFormat);

    expect(result.unix).toEqual(['custom-cmd-1', 'custom-cmd-2']);
    expect(result.windows).toEqual(defaults.windows);
  });

  it('should normalize valid platform-keyed object', () => {
    const input = {
      unix: ['unix-cmd'],
      windows: ['windows-cmd'],
    };

    const result = normalizeBlockedCommands(input);

    expect(result.unix).toEqual(['unix-cmd']);
    expect(result.windows).toEqual(['windows-cmd']);
  });

  it('should filter out non-string entries', () => {
    const input = {
      unix: ['valid', 123, null, 'also-valid'] as unknown[],
      windows: [true, 'windows-cmd', {}] as unknown[],
    };

    const result = normalizeBlockedCommands(input);

    expect(result.unix).toEqual(['valid', 'also-valid']);
    expect(result.windows).toEqual(['windows-cmd']);
  });

  it('should trim whitespace from commands', () => {
    const input = {
      unix: ['  cmd1  ', 'cmd2  '],
      windows: ['  win-cmd  '],
    };

    const result = normalizeBlockedCommands(input);

    expect(result.unix).toEqual(['cmd1', 'cmd2']);
    expect(result.windows).toEqual(['win-cmd']);
  });

  it('should filter out empty strings after trimming', () => {
    const input = {
      unix: ['cmd1', '   ', '', 'cmd2'],
      windows: ['', 'win-cmd'],
    };

    const result = normalizeBlockedCommands(input);

    expect(result.unix).toEqual(['cmd1', 'cmd2']);
    expect(result.windows).toEqual(['win-cmd']);
  });

  it('should use defaults for missing platform keys', () => {
    const input = {
      unix: ['custom-unix'],
      // windows is missing
    };

    const result = normalizeBlockedCommands(input);

    expect(result.unix).toEqual(['custom-unix']);
    expect(result.windows).toEqual(defaults.windows);
  });

  it('should handle non-object, non-array input', () => {
    expect(normalizeBlockedCommands('string')).toEqual(defaults);
    expect(normalizeBlockedCommands(123)).toEqual(defaults);
    expect(normalizeBlockedCommands(true)).toEqual(defaults);
  });
});

