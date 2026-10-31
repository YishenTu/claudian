import '@/providers';

import * as ClaudeHistoryStore from '@/providers/claude/history/ClaudeHistoryStore';
import { ClaudeSubagentHistoryService } from '@/providers/claude/history/ClaudeSubagentHistoryService';

describe('ClaudeSubagentHistoryService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads provider-native sidecar data with Claude-owned path context', async () => {
    const loadToolCalls = vi.spyOn(ClaudeHistoryStore, 'loadSubagentToolCalls')
      .mockResolvedValue([{ id: 'tool-1', name: 'Read', input: {}, status: 'completed' }]);
    const loadFinalResult = vi.spyOn(ClaudeHistoryStore, 'loadSubagentFinalResult')
      .mockResolvedValue('Final result');
    const host = { environmentText: 'CLAUDE_CONFIG_DIR=/tmp/claude-config' };
    const service = new ClaudeSubagentHistoryService(host);
    const request = {
      providerSessionId: 'session-1',
      subagentId: 'agent-1',
      vaultPath: '/vault',
    };

    await expect(service.loadToolCalls(request)).resolves.toEqual([{ id: 'tool-1', name: 'Read', input: {}, status: 'completed' }]);
    await expect(service.loadFinalResult(request)).resolves.toBe('Final result');

    const expectedContext = expect.objectContaining({
      environment: expect.objectContaining({
        CLAUDE_CONFIG_DIR: '/tmp/claude-config',
      }),
      hostPlatform: process.platform,
      vaultPath: '/vault',
    });
    expect(loadToolCalls).toHaveBeenCalledWith(
      '/vault',
      'session-1',
      'agent-1',
      undefined,
      expectedContext,
    );
    expect(loadFinalResult).toHaveBeenCalledWith(
      '/vault',
      'session-1',
      'agent-1',
      undefined,
      expectedContext,
    );
  });
});
