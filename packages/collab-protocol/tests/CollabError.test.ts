import {
  COLLAB_ERROR_CODES,
  CollabError,
  collabErrorGroup,
  sanitizeCollabDiagnosticContext,
  type CollabErrorGroup,
} from '../src/CollabError';

describe('CollabError', () => {
  it('exports only decision-complete shared wire errors', () => {
    expect(COLLAB_ERROR_CODES).toEqual([
      'protocol-version-unsupported',
      'protocol-payload-invalid',
      'project-not-found',
      'quota-exceeded',
      'authentication-failed',
      'authorization-denied',
      'membership-revoked',
      'stale-main',
      'stale-request-head',
      'personal-ref-diverged',
      'content-conflict',
      'description-required',
      'request-not-open',
      'request-head-not-pushed',
      'ticket-not-found',
      'resolving-ticket-reference-not-found',
      'ticket-not-open',
      'stale-ticket',
      'stale-request-metadata',
      'authority-not-synchronized',
      'idempotency-conflict',
      'acceptance-recovery-required',
      'authority-integrity-error',
      'operation-timeout',
      'operation-failed',
    ]);
    for (const code of COLLAB_ERROR_CODES) {
      expect([
        'setup',
        'path',
        'authorization',
        'state',
        'integrity',
        'operation',
      ]).toContain(collabErrorGroup(code));
    }
    expect(new Set(COLLAB_ERROR_CODES.map(collabErrorGroup))).toEqual(new Set([
      'setup',
      'path',
      'authorization',
      'state',
      'integrity',
      'operation',
    ]));
  });

  it('rejects error vocabulary outside the shared wire contract at runtime', () => {
    expect(() => new CollabError({
      code: 'offline',
    } as never)).toThrow('Unsupported Collab error code');
    expect(() => new CollabError({
      code: 'operation-failed',
      recoveryActions: ['refresh-invitation'],
    } as never)).toThrow('Unsupported Collab recovery action');
  });

  it('keeps Claudian connectivity grouping outside the shared type', () => {
    // @ts-expect-error connectivity is a Claudian application group, not shared wire vocabulary
    const group: CollabErrorGroup = 'connectivity';
    expect(group).toBe('connectivity');
  });

  it('retains only allowlisted safe diagnostic fields', () => {
    const sanitized = sanitizeCollabDiagnosticContext({
      projectId: 'project_1',
      endpoint: 'https://192.168.1.10:54545',
      credential: 'member-secret',
      body: 'private Project contents',
      exception: 'SQL connection failed for customer record',
      relativePath: 'Vault/Private/note.md',
      nested: {
        invitationSecret: 'invite-secret',
        tokenHash: 'token-hash',
        workspacePath: '/Users/alice/Vault/workspace/project',
        windowsPath: 'C:\\Users\\Alice\\Vault',
      },
      values: ['safe', '/home/alice/private'],
      stderr: 'fatal: cannot open /Users/alice/Vault/private.md',
      windowsStderr: 'fatal: cannot open C:\\Users\\Alice\\Vault\\private.md',
    });

    expect(sanitized).toEqual({
      projectId: 'project_1',
      endpoint: '[PATH]',
    });
  });

  it('serializes only stable, safe diagnostic fields', () => {
    const error = new CollabError({
      code: 'stale-main',
      safeContext: {
        projectId: 'project_1',
        invitationSecret: 'never-serialize-me',
      },
      recoveryActions: ['review-conflicts', 'retry'],
      cause: new Error('raw transport failure with private details'),
    });

    expect(error.message).toBe('collab.error.stale-main');
    expect(error.group).toBe('state');
    expect(error.toJSON()).toEqual({
      name: 'CollabError',
      code: 'stale-main',
      group: 'state',
      message: 'collab.error.stale-main',
      safeContext: {
        projectId: 'project_1',
      },
      recoveryActions: ['review-conflicts', 'retry'],
    });
    expect(JSON.stringify(error)).not.toContain('never-serialize-me');
    expect(JSON.stringify(error)).not.toContain('raw transport failure');
  });

  it('redacts receiver material from shared errors', () => {
    const error = new CollabError({
      code: 'authority-not-synchronized',
      safeContext: {
        projectId: 'project_1',
        offerId: 'offer_1',
        status: 'offered',
        receiverCredential: 'never-serialize',
      },
    });
    expect(error.safeContext).toEqual({
      projectId: 'project_1',
      status: 'offered',
    });
  });
});
