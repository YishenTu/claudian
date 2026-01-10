import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { computeSystemPromptKey, isTurnCompleteMessage } from '@/core/agent/types';

describe('isTurnCompleteMessage', () => {
  it('returns true for result message', () => {
    const message = { type: 'result' } as SDKMessage;
    expect(isTurnCompleteMessage(message)).toBe(true);
  });

  it('returns true for error message', () => {
    // Error type may not be in SDK types but can occur at runtime
    const message = { type: 'error' } as unknown as SDKMessage;
    expect(isTurnCompleteMessage(message)).toBe(true);
  });

  it('returns false for assistant message', () => {
    const message = { type: 'assistant' } as SDKMessage;
    expect(isTurnCompleteMessage(message)).toBe(false);
  });

  it('returns false for user message', () => {
    const message = { type: 'user' } as SDKMessage;
    expect(isTurnCompleteMessage(message)).toBe(false);
  });

  it('returns false for system message', () => {
    const message = { type: 'system' } as SDKMessage;
    expect(isTurnCompleteMessage(message)).toBe(false);
  });
});

describe('computeSystemPromptKey', () => {
  it('computes key from all settings', () => {
    const settings = {
      mediaFolder: 'attachments',
      customPrompt: 'Be helpful',
      allowedExportPaths: ['/path/b', '/path/a'],
      vaultPath: '/vault',
    };

    const key = computeSystemPromptKey(settings);

    // Paths should be sorted
    expect(key).toBe('attachments::Be helpful::/path/a|/path/b::/vault');
  });

  it('handles empty/undefined values', () => {
    const settings = {
      mediaFolder: '',
      customPrompt: '',
      allowedExportPaths: [],
      vaultPath: '',
    };

    const key = computeSystemPromptKey(settings);
    // 4 empty parts joined with '::' = 3 separators = 6 colons
    expect(key).toBe('::::::');
  });

  it('produces different keys for different inputs', () => {
    const settings1 = {
      mediaFolder: 'attachments',
      customPrompt: 'Be helpful',
      allowedExportPaths: [],
      vaultPath: '/vault1',
    };
    const settings2 = {
      mediaFolder: 'attachments',
      customPrompt: 'Be helpful',
      allowedExportPaths: [],
      vaultPath: '/vault2',
    };

    expect(computeSystemPromptKey(settings1)).not.toBe(computeSystemPromptKey(settings2));
  });

  it('produces same key for equivalent inputs with different path order', () => {
    const settings1 = {
      mediaFolder: '',
      customPrompt: '',
      allowedExportPaths: ['/a', '/b', '/c'],
      vaultPath: '',
    };
    const settings2 = {
      mediaFolder: '',
      customPrompt: '',
      allowedExportPaths: ['/c', '/a', '/b'],
      vaultPath: '',
    };

    // Paths are sorted, so order shouldn't matter
    expect(computeSystemPromptKey(settings1)).toBe(computeSystemPromptKey(settings2));
  });
});
