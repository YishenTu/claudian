import { buildCodexCommandApprovalDisplay } from '@/providers/codex/runtime/codexApprovalDisplay';

describe('buildCodexCommandApprovalDisplay', () => {
  it('uses Codex command actions as the readable display and preserves the exact command', () => {
    expect(buildCodexCommandApprovalDisplay({
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      command: 'powershell.exe -Command "Get-ChildItem -Force"',
      cwd: 'C:\\workspace',
      commandActions: [
        { type: 'listFiles', command: 'Get-ChildItem -Force', path: null },
      ],
    })).toEqual({
      actions: [
        { label: 'List files', command: 'Get-ChildItem -Force' },
      ],
      exactCommand: 'powershell.exe -Command "Get-ChildItem -Force"',
    });
  });

  it('keeps multiple semantic actions in execution order', () => {
    expect(buildCodexCommandApprovalDisplay({
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      command: 'wrapped command',
      cwd: '/workspace',
      commandActions: [
        {
          type: 'search',
          command: 'rg "TODO" src',
          query: 'TODO',
          path: 'src',
        },
        {
          type: 'read',
          command: 'Get-Content src/app.ts',
          name: 'app.ts',
          path: 'C:\\workspace\\src\\app.ts',
        },
      ],
    })).toEqual({
      actions: [
        { label: 'Search for TODO in src', command: 'rg "TODO" src' },
        { label: 'Read app.ts', command: 'Get-Content src/app.ts' },
      ],
      exactCommand: 'wrapped command',
    });
  });

  it('returns only the exact command when Codex cannot parse semantic actions', () => {
    expect(buildCodexCommandApprovalDisplay({
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      command: 'Write-Output "hello"',
      cwd: 'C:\\workspace',
      commandActions: null,
    })).toEqual({
      actions: [],
      exactCommand: 'Write-Output "hello"',
    });
  });
});
