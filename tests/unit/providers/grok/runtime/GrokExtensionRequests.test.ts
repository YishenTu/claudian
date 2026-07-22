import type { AcpJsonRpcTransport } from '@/providers/acp';
import { requestGrokRewind } from '@/providers/grok/runtime/GrokExtensionRequests';

describe('GrokExtensionRequests rewind', () => {
  it('preserves dry-run conflicts even though native preview success is false', async () => {
    const request = jest.fn().mockResolvedValue({
      clean_files: ['src/clean.ts'],
      conflicts: [{ conflict_type: 'modified_externally', path: 'src/conflicted.ts' }],
      error: 'External modifications detected. Confirm to revert anyway.',
      mode: 'all',
      prompt_text: null,
      reverted_files: [],
      success: false,
      target_prompt_index: 1,
    });
    const transport = { request } as unknown as AcpJsonRpcTransport;

    await expect(requestGrokRewind(transport, {
      force: false,
      mode: 'all',
      sessionId: 'session-rewind',
      targetPromptIndex: 1,
    })).resolves.toEqual({
      cleanFiles: ['src/clean.ts'],
      conflicts: [{ conflictType: 'modified_externally', path: 'src/conflicted.ts' }],
      error: 'External modifications detected. Confirm to revert anyway.',
      mode: 'all',
      promptText: null,
      revertedFiles: [],
      success: false,
      targetPromptIndex: 1,
    });
    expect(request).toHaveBeenCalledWith(
      '_x.ai/rewind/execute',
      {
        force: false,
        mode: 'all',
        sessionId: 'session-rewind',
        targetPromptIndex: 1,
      },
      { timeoutMs: 120_000 },
    );
  });

  it('rejects malformed native rewind responses', async () => {
    const transport = {
      request: jest.fn().mockResolvedValue({ success: true }),
    } as unknown as AcpJsonRpcTransport;

    await expect(requestGrokRewind(transport, {
      force: true,
      mode: 'conversation_only',
      sessionId: 'session-rewind',
      targetPromptIndex: 0,
    })).rejects.toThrow('malformed rewind response');
  });

  it('does not release a forced rewind before the provider outcome is known', async () => {
    const request = jest.fn().mockResolvedValue({
      clean_files: [],
      conflicts: [],
      error: null,
      mode: 'all',
      prompt_text: 'Prompt',
      reverted_files: [],
      success: true,
      target_prompt_index: 1,
    });
    const transport = { request } as unknown as AcpJsonRpcTransport;

    await requestGrokRewind(transport, {
      force: true,
      mode: 'all',
      sessionId: 'session-rewind',
      targetPromptIndex: 1,
    });

    expect(request).toHaveBeenCalledWith(
      '_x.ai/rewind/execute',
      expect.any(Object),
      { timeoutMs: 0 },
    );
  });
});
