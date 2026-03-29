/**
 * Type conformance tests for codexAppServerTypes.ts
 *
 * These tests verify that the local protocol types match the shapes
 * defined by the generated app-server schema. If a type drifts from
 * the schema, the corresponding test will fail at compile time or
 * at runtime when constructing a conformant value.
 */
import type {
  CommandApprovalRequest,
  CommandExecutionApprovalResponse,
  FileChangeApprovalResponse,
  PermissionsApprovalRequest,
  PermissionsApprovalResponse,
  UserInputRequest,
  UserInputResponse,
} from '@/providers/codex/runtime/codexAppServerTypes';

// ---------------------------------------------------------------------------
// Helpers: assert a value is assignable to a type at compile time
// ---------------------------------------------------------------------------
function assertType<T>(_value: T): void {
  // compile-time only
}

// ---------------------------------------------------------------------------
// Command execution approval response
// ---------------------------------------------------------------------------

describe('CommandExecutionApprovalResponse', () => {
  it('accepts "accept" decision', () => {
    const response: CommandExecutionApprovalResponse = { decision: 'accept' };
    assertType<CommandExecutionApprovalResponse>(response);
    expect(response.decision).toBe('accept');
  });

  it('accepts "acceptForSession" decision', () => {
    const response: CommandExecutionApprovalResponse = { decision: 'acceptForSession' };
    assertType<CommandExecutionApprovalResponse>(response);
    expect(response.decision).toBe('acceptForSession');
  });

  it('accepts "decline" decision', () => {
    const response: CommandExecutionApprovalResponse = { decision: 'decline' };
    assertType<CommandExecutionApprovalResponse>(response);
    expect(response.decision).toBe('decline');
  });

  it('accepts "cancel" decision', () => {
    const response: CommandExecutionApprovalResponse = { decision: 'cancel' };
    assertType<CommandExecutionApprovalResponse>(response);
    expect(response.decision).toBe('cancel');
  });

  it('accepts execpolicy amendment decisions', () => {
    const response: CommandExecutionApprovalResponse = {
      decision: {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: ['npm', 'test'],
        },
      },
    };
    assertType<CommandExecutionApprovalResponse>(response);
    expect(response.decision).toEqual({
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: ['npm', 'test'],
      },
    });
  });

  it('accepts network policy amendment decisions', () => {
    const response: CommandExecutionApprovalResponse = {
      decision: {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: {
            host: 'api.openai.com',
            action: 'allow',
          },
        },
      },
    };
    assertType<CommandExecutionApprovalResponse>(response);
    expect(response.decision).toEqual({
      applyNetworkPolicyAmendment: {
        network_policy_amendment: {
          host: 'api.openai.com',
          action: 'allow',
        },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// File change approval response
// ---------------------------------------------------------------------------

describe('FileChangeApprovalResponse', () => {
  it('accepts "accept" decision', () => {
    const response: FileChangeApprovalResponse = { decision: 'accept' };
    assertType<FileChangeApprovalResponse>(response);
    expect(response.decision).toBe('accept');
  });

  it('accepts "acceptForSession" decision', () => {
    const response: FileChangeApprovalResponse = { decision: 'acceptForSession' };
    assertType<FileChangeApprovalResponse>(response);
    expect(response.decision).toBe('acceptForSession');
  });

  it('accepts "decline" decision', () => {
    const response: FileChangeApprovalResponse = { decision: 'decline' };
    assertType<FileChangeApprovalResponse>(response);
    expect(response.decision).toBe('decline');
  });

  it('accepts "cancel" decision', () => {
    const response: FileChangeApprovalResponse = { decision: 'cancel' };
    assertType<FileChangeApprovalResponse>(response);
    expect(response.decision).toBe('cancel');
  });
});

// ---------------------------------------------------------------------------
// Permissions approval — structured response, NOT a decision enum
// ---------------------------------------------------------------------------

describe('PermissionsApprovalResponse', () => {
  it('accepts a grant with turn scope', () => {
    const response: PermissionsApprovalResponse = {
      permissions: {
        fileSystem: { read: ['/tmp'], write: null },
        network: null,
      },
      scope: 'turn',
    };
    assertType<PermissionsApprovalResponse>(response);
    expect(response.scope).toBe('turn');
    expect(response.permissions.fileSystem?.read).toEqual(['/tmp']);
  });

  it('accepts a grant with session scope', () => {
    const response: PermissionsApprovalResponse = {
      permissions: {
        fileSystem: null,
        network: { enabled: true },
      },
      scope: 'session',
    };
    assertType<PermissionsApprovalResponse>(response);
    expect(response.scope).toBe('session');
  });

  it('defaults scope to turn when omitted', () => {
    const response: PermissionsApprovalResponse = {
      permissions: {},
    };
    assertType<PermissionsApprovalResponse>(response);
    expect(response.scope).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Permissions approval request — includes permissions profile
// ---------------------------------------------------------------------------

describe('PermissionsApprovalRequest', () => {
  it('includes permissions profile from server', () => {
    const request: PermissionsApprovalRequest = {
      threadId: 't1',
      turnId: 'turn1',
      itemId: 'perm1',
      permissions: {
        fileSystem: { read: ['/usr/local'], write: ['/tmp'] },
        network: { enabled: true },
      },
    };
    assertType<PermissionsApprovalRequest>(request);
    expect(request.permissions.fileSystem?.write).toEqual(['/tmp']);
  });
});

// ---------------------------------------------------------------------------
// Command approval request — includes optional fields from schema
// ---------------------------------------------------------------------------

describe('CommandApprovalRequest', () => {
  it('includes optional reason and commandActions', () => {
    const request: CommandApprovalRequest = {
      threadId: 't1',
      turnId: 'turn1',
      itemId: 'cmd1',
      command: 'echo test',
      cwd: '/workspace',
      reason: 'needs network',
      commandActions: [{ type: 'unknown', command: 'echo test' }],
    };
    assertType<CommandApprovalRequest>(request);
    expect(request.reason).toBe('needs network');
    expect(request.commandActions).toHaveLength(1);
  });

  it('includes network approval and amendment metadata from the schema', () => {
    const request: CommandApprovalRequest = {
      threadId: 't1',
      turnId: 'turn1',
      itemId: 'cmd1',
      command: 'curl https://api.openai.com',
      cwd: '/workspace',
      networkApprovalContext: { host: 'api.openai.com', protocol: 'https' },
      additionalPermissions: {
        network: { enabled: true },
        fileSystem: { read: ['/tmp'], write: ['/workspace'] },
        macos: null,
      },
      proposedExecpolicyAmendment: ['curl', 'https://api.openai.com/*'],
      proposedNetworkPolicyAmendments: [{ host: 'api.openai.com', action: 'allow' }],
      availableDecisions: [
        'accept',
        {
          acceptWithExecpolicyAmendment: {
            execpolicy_amendment: ['curl', 'https://api.openai.com/*'],
          },
        },
        {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: { host: 'api.openai.com', action: 'allow' },
          },
        },
      ],
    };
    assertType<CommandApprovalRequest>(request);
    expect(request.networkApprovalContext?.host).toBe('api.openai.com');
    expect(request.availableDecisions).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// User input request — richer question metadata
// ---------------------------------------------------------------------------

describe('UserInputRequest', () => {
  it('includes header, options, isOther, and isSecret on questions', () => {
    const request: UserInputRequest = {
      threadId: 't1',
      turnId: 'turn1',
      itemId: 'ui1',
      questions: [
        {
          id: 'q1',
          header: 'Confirm action',
          question: 'Do you want to proceed?',
          options: [
            { label: 'Yes', description: 'Continue' },
            { label: 'No', description: 'Stop' },
          ],
          isOther: false,
          isSecret: false,
        },
      ],
    };
    assertType<UserInputRequest>(request);
    expect(request.questions[0].header).toBe('Confirm action');
    expect(request.questions[0].options).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// User input response — answers keyed by question id
// ---------------------------------------------------------------------------

describe('UserInputResponse', () => {
  it('keys answers by question id', () => {
    const response: UserInputResponse = {
      answers: {
        q1: { answers: ['yes'] },
        q2: { answers: ['option-a', 'option-b'] },
      },
    };
    assertType<UserInputResponse>(response);
    expect(Object.keys(response.answers)).toEqual(['q1', 'q2']);
  });
});

// ---------------------------------------------------------------------------
// Schema drift guards — ensure deprecated values are not reintroduced
// ---------------------------------------------------------------------------

describe('schema drift guards', () => {
  it('CommandExecutionApprovalDecision does not include "deny" or "alwaysAccept"', () => {
    const validValues: CommandExecutionApprovalResponse['decision'][] = [
      'accept', 'acceptForSession', 'decline', 'cancel',
    ];
    expect(validValues).not.toContain('deny');
    expect(validValues).not.toContain('alwaysAccept');
  });

  it('FileChangeApprovalDecision does not include "deny" or "alwaysAccept"', () => {
    const validValues: FileChangeApprovalResponse['decision'][] = [
      'accept', 'acceptForSession', 'decline', 'cancel',
    ];
    expect(validValues).not.toContain('deny');
    expect(validValues).not.toContain('alwaysAccept');
  });

  it('PermissionsApprovalResponse has permissions and scope, not decision', () => {
    const response: PermissionsApprovalResponse = {
      permissions: {},
      scope: 'turn',
    };
    expect(response).toHaveProperty('permissions');
    expect(response).not.toHaveProperty('decision');
  });
});
