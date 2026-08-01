import '@/providers';

import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import * as ClaudeHistoryStore from '@/providers/claude/history/ClaudeHistoryStore';
import { ClaudeSubagentHistoryService } from '@/providers/claude/history/ClaudeSubagentHistoryService';

describe('ClaudeSubagentHistoryService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('loads provider-native sidecar data with Claude-owned path context', async () => {
    const loadToolCalls = jest.spyOn(ClaudeHistoryStore, 'loadSubagentToolCalls')
      .mockResolvedValue([{ id: 'tool-1' }] as any);
    const loadFinalResult = jest.spyOn(ClaudeHistoryStore, 'loadSubagentFinalResult')
      .mockResolvedValue('Final result');
    const host = {
      executionLifecycleRegistry: new ProviderExecutionLifecycleRegistry(),
      getActiveEnvironmentVariables: jest.fn()
        .mockReturnValue('CLAUDE_CONFIG_DIR=/tmp/claude-config'),
      settings: {
        model: 'claude-sonnet-4-5',
        providerConfigs: {},
      },
    } as any;
    const service = new ClaudeSubagentHistoryService(host);
    const request = {
      providerSessionId: 'session-1',
      subagentId: 'agent-1',
      vaultPath: '/vault',
    };

    await expect(service.loadToolCalls(request)).resolves.toEqual([{ id: 'tool-1' }]);
    await expect(service.loadFinalResult(request)).resolves.toBe('Final result');

    const expectedContext = expect.objectContaining({
      environment: expect.objectContaining({
        CLAUDE_CONFIG_DIR: '/tmp/claude-config',
      }),
      hostPlatform: process.platform,
      settings: expect.objectContaining({ model: 'claude-sonnet-4-5' }),
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
