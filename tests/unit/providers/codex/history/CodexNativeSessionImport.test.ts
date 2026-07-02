import type * as fsType from 'fs';
import type * as osType from 'os';
import type * as pathType from 'path';

const fs = jest.requireActual<typeof fsType>('fs');
const os = jest.requireActual<typeof osType>('os');
const path = jest.requireActual<typeof pathType>('path');

import type { SessionMetadata } from '@/core/types';
import { importCodexNativeSessionsForVault } from '@/providers/codex/history/CodexNativeSessionImport';

function writeSession(filePath: string, params: {
  cwd: string;
  threadId: string;
  extraUserMessage?: string;
  userMessage?: string;
  timestamp?: string;
}): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const timestamp = params.timestamp ?? '2026-06-01T00:00:00.000Z';
  fs.writeFileSync(
    filePath,
    [
      JSON.stringify({
        type: 'session_meta',
        timestamp,
        payload: {
          id: params.threadId,
          cwd: params.cwd,
          timestamp,
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-06-01T00:00:01.000Z',
        payload: {
          type: 'user_message',
          message: params.userMessage ?? 'Summarize this vault',
        },
      }),
      ...(params.extraUserMessage ? [JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-06-01T00:00:01.500Z',
        payload: {
          type: 'user_message',
          message: params.extraUserMessage,
        },
      })] : []),
      JSON.stringify({
        type: 'turn_context',
        timestamp: '2026-06-01T00:00:02.000Z',
        payload: {
          cwd: params.cwd,
        },
      }),
    ].join('\n'),
    'utf-8',
  );
}

describe('importCodexNativeSessionsForVault', () => {
  let tempDir: string;
  let sessionsRoot: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-codex-import-'));
    sessionsRoot = path.join(tempDir, '.codex', 'sessions');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('imports native Codex sessions whose cwd is the current vault', () => {
    const vaultPath = path.join(tempDir, 'vault');
    const sessionFile = path.join(sessionsRoot, '2026', '06', '01', 'rollout-thread-1.jsonl');
    writeSession(sessionFile, {
      cwd: vaultPath,
      threadId: 'thread-1',
      userMessage: 'Count todos',
    });

    const result = importCodexNativeSessionsForVault({
      existingMetadata: [],
      sessionsRoot,
      vaultPath,
    });

    expect(result.imported).toHaveLength(1);
    expect(result.imported[0]).toMatchObject({
      id: 'codex-thread-1',
      providerId: 'codex',
      title: 'Count todos',
      sessionId: 'thread-1',
      providerState: {
        threadId: 'thread-1',
        sessionFilePath: sessionFile,
      },
    });
  });

  it('allows sessions from current vault subdirectories', () => {
    const vaultPath = path.join(tempDir, 'vault');
    writeSession(path.join(sessionsRoot, 'rollout-thread-child.jsonl'), {
      cwd: path.join(vaultPath, 'notes', 'project-a'),
      threadId: 'thread-child',
    });

    const result = importCodexNativeSessionsForVault({
      existingMetadata: [],
      sessionsRoot,
      vaultPath,
    });

    expect(result.imported.map(meta => meta.sessionId)).toEqual(['thread-child']);
  });

  it('skips sessions outside the current vault', () => {
    const vaultPath = path.join(tempDir, 'vault');
    writeSession(path.join(sessionsRoot, 'rollout-thread-other.jsonl'), {
      cwd: path.join(tempDir, 'other-vault'),
      threadId: 'thread-other',
    });

    const result = importCodexNativeSessionsForVault({
      existingMetadata: [],
      sessionsRoot,
      vaultPath,
    });

    expect(result.imported).toHaveLength(0);
    expect(result.skippedOtherWorkspace).toBe(1);
  });

  it('skips sessions already represented by existing metadata', () => {
    const vaultPath = path.join(tempDir, 'vault');
    const sessionFile = path.join(sessionsRoot, 'rollout-thread-duplicate.jsonl');
    writeSession(sessionFile, {
      cwd: vaultPath,
      threadId: 'thread-duplicate',
    });

    const existingMetadata: SessionMetadata[] = [{
      id: 'existing',
      providerId: 'codex',
      title: 'Existing',
      createdAt: 1,
      updatedAt: 1,
      sessionId: 'thread-duplicate',
    }];

    const result = importCodexNativeSessionsForVault({
      existingMetadata,
      sessionsRoot,
      vaultPath,
    });

    expect(result.imported).toHaveLength(0);
    expect(result.skippedDuplicate).toBe(1);
  });

  it('skips setup context messages when deriving the imported title', () => {
    const vaultPath = path.join(tempDir, 'vault');
    writeSession(path.join(sessionsRoot, 'rollout-thread-context.jsonl'), {
      cwd: vaultPath,
      threadId: 'thread-context',
      userMessage: '# AGENTS.md instructions for /vault\n\n<INSTRUCTIONS>\n硬约束\n</INSTRUCTIONS>',
      extraUserMessage: 'Real user request',
    });

    const result = importCodexNativeSessionsForVault({
      existingMetadata: [],
      sessionsRoot,
      vaultPath,
    });

    expect(result.imported[0]?.title).toBe('Real user request');
  });
});
