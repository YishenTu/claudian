import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  type AcpRequestPermissionRequest,
  JsonRpcErrorResponse,
} from '@/providers/acp';
import {
  classifyOpencodeSessionLoadError,
  OpencodeSessionMissingError,
  presentOpencodePermission,
  resolveOpencodeReadPath,
} from '@/providers/opencode/execution/OpencodeAcpSessionKernel';

function permissionRequest(
  title: string,
  rawInput: Record<string, unknown>,
  locations?: Array<{ path: string }>,
): AcpRequestPermissionRequest {
  return {
    options: [],
    sessionId: 'native-session',
    toolCall: {
      locations,
      rawInput,
      title,
      toolCallId: 'tool-1',
    },
  };
}

describe('OpencodeAcpSessionKernel read policy', () => {
  it('bounds read-only callbacks to the active workspace', () => {
    expect(resolveOpencodeReadPath('/vault', 'notes/file.md')).toBe(
      '/vault/notes/file.md',
    );
    expect(() => resolveOpencodeReadPath('/vault', '../secret')).toThrow(
      'OpenCode read access is limited to the current workspace',
    );
    expect(() => resolveOpencodeReadPath('/vault', '/outside/secret')).toThrow(
      'OpenCode read access is limited to the current workspace',
    );
  });

  it('rejects an in-workspace symlink whose canonical target is outside', () => {
    const testRoot = mkdtempSync(path.join(tmpdir(), 'claudian-opencode-read-'));
    const workspaceRoot = path.join(testRoot, 'vault');
    const outsideRoot = path.join(testRoot, 'outside');
    mkdirSync(workspaceRoot);
    mkdirSync(outsideRoot);
    const outsideFile = path.join(outsideRoot, 'secret.md');
    writeFileSync(outsideFile, 'secret', 'utf8');
    symlinkSync(outsideFile, path.join(workspaceRoot, 'linked-secret.md'));

    try {
      expect(() => resolveOpencodeReadPath(
        workspaceRoot,
        'linked-secret.md',
      )).toThrow('OpenCode read access is limited to the current workspace');
    } finally {
      rmSync(testRoot, { force: true, recursive: true });
    }
  });

  it('rejects a dangling in-workspace symlink targeting an outside path', () => {
    const testRoot = mkdtempSync(path.join(tmpdir(), 'claudian-opencode-read-'));
    const workspaceRoot = path.join(testRoot, 'vault');
    const outsideTarget = path.join(testRoot, 'outside', 'missing.md');
    mkdirSync(workspaceRoot);
    symlinkSync(outsideTarget, path.join(workspaceRoot, 'linked-missing.md'));

    try {
      expect(() => resolveOpencodeReadPath(
        workspaceRoot,
        'linked-missing.md',
      )).toThrow('OpenCode read access is limited to the current workspace');
    } finally {
      rmSync(testRoot, { force: true, recursive: true });
    }
  });

  it('returns the canonical validated target and preserves missing paths', () => {
    const testRoot = mkdtempSync(path.join(tmpdir(), 'claudian-opencode-read-'));
    const workspaceRoot = path.join(testRoot, 'vault');
    const notesRoot = path.join(workspaceRoot, 'notes');
    mkdirSync(notesRoot, { recursive: true });
    const notePath = path.join(notesRoot, 'note.md');
    writeFileSync(notePath, 'note', 'utf8');
    symlinkSync(notesRoot, path.join(workspaceRoot, 'linked-notes'));

    try {
      expect(resolveOpencodeReadPath(
        workspaceRoot,
        'linked-notes/note.md',
      )).toBe(realpathSync.native(notePath));
      expect(resolveOpencodeReadPath(
        workspaceRoot,
        'linked-notes/missing.md',
      )).toBe(path.join(realpathSync.native(notesRoot), 'missing.md'));
    } finally {
      rmSync(testRoot, { force: true, recursive: true });
    }
  });
});

describe('OpencodeAcpSessionKernel permission presentation', () => {
  it('preserves an external-directory path from ACP locations', () => {
    const request = permissionRequest(
      'external_directory',
      {},
      [{ path: '/outside/private.md' }],
    );

    expect(presentOpencodePermission(request, {})).toEqual({
      blockedPath: '/outside/private.md',
      decisionReason: 'Path is outside the session working directory',
      description: 'OpenCode wants to access a path outside the working directory.',
      toolName: 'External Directory',
    });
  });

  it('preserves file permission context from normalized input', () => {
    const request = permissionRequest('edit', {
      filePath: '/vault/notes/today.md',
    });

    expect(presentOpencodePermission(request, {
      filePath: '/vault/notes/today.md',
    })).toEqual({
      blockedPath: '/vault/notes/today.md',
      decisionReason: 'File write permission required',
      description: 'OpenCode wants to modify this file.',
      toolName: 'edit',
    });
  });
});

describe('OpenCode session/load errors', () => {
  it('wraps explicit missing-session protocol evidence with the attempted ID', () => {
    const classified = classifyOpencodeSessionLoadError(
      new JsonRpcErrorResponse(
        'session/load',
        -32000,
        'Session not found',
        { kind: 'session_not_found' },
      ),
      'attempted-session',
    );

    expect(classified).toBeInstanceOf(OpencodeSessionMissingError);
    expect(classified).toMatchObject({ sessionId: 'attempted-session' });
  });

  it.each([
    new Error('Session not found'),
    new JsonRpcErrorResponse('session/load', -32000, 'Authentication required'),
    new JsonRpcErrorResponse('session/load', -32000, 'Invalid configuration'),
    new JsonRpcErrorResponse('session/prompt', -32000, 'Session not found'),
  ])('preserves non-missing or uncorrelated failures: %p', (error) => {
    expect(classifyOpencodeSessionLoadError(error, 'valid-session')).toBe(error);
  });
});
