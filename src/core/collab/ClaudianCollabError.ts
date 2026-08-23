import {
  COLLAB_ERROR_CODES as SHARED_COLLAB_ERROR_CODES,
  type CollabDiagnosticContext,
  CollabError as SharedCollabError,
  type CollabErrorCode as SharedCollabErrorCode,
  type CollabErrorGroup as SharedCollabErrorGroup,
  collabErrorGroup as sharedCollabErrorGroup,
  type CollabRecoveryAction as SharedCollabRecoveryAction,
  sanitizeCollabDiagnosticContext,
} from '@claudian-collab/protocol';

export const COLLAB_LOCAL_ERROR_CODES = Object.freeze([
  'not-initialized',
  'git-not-found',
  'git-version-unsupported',
  'git-capability-missing',
  'schema-version-unsupported',
  'workspace-boundary-invalid',
  'path-invalid',
  'path-outside-project',
  'path-not-portable',
  'unsupported-file-type',
  'repository-invalid',
  'repository-corrupt',
  'offline',
  'host-stopped',
  'endpoint-unreachable',
  'local-network-permission-required',
  'tls-untrusted',
  'tls-ca-mismatch',
  'invitation-invalid',
  'invitation-expired',
  'invitation-revoked',
  'stale-project-selection',
  'working-tree-busy',
  'project-retired',
  'host-transfer-pending',
  'manager-responsibility-pending',
  'database-corrupt',
  'cancelled',
  'durable-progress-recovery-required',
] as const);

export type ClaudianCollabErrorCode = typeof COLLAB_LOCAL_ERROR_CODES[number];
export type CollabErrorCode = SharedCollabErrorCode | ClaudianCollabErrorCode;
export type CollabErrorGroup = SharedCollabErrorGroup | 'connectivity';

export const COLLAB_LOCAL_RECOVERY_ACTIONS = Object.freeze([
  'install-git',
  'rescan-git',
  'choose-git-path',
  'resume',
  'open-diagnostics',
  'reclone',
  'refresh-invitation',
  'promote-manager',
  'restart-host',
  'export-repair-data',
] as const);

export type ClaudianCollabRecoveryAction = typeof COLLAB_LOCAL_RECOVERY_ACTIONS[number];
export type CollabRecoveryAction = SharedCollabRecoveryAction | ClaudianCollabRecoveryAction;

export interface CollabErrorOptions {
  code: CollabErrorCode;
  safeContext?: Readonly<Record<string, unknown>>;
  recoveryActions?: readonly CollabRecoveryAction[];
  cause?: unknown;
}

const SHARED_ERROR_CODES: ReadonlySet<string> = new Set(SHARED_COLLAB_ERROR_CODES);

function localCollabErrorGroup(code: ClaudianCollabErrorCode): CollabErrorGroup {
  switch (code) {
    case 'not-initialized':
    case 'git-not-found':
    case 'git-version-unsupported':
    case 'git-capability-missing':
    case 'schema-version-unsupported':
      return 'setup';
    case 'workspace-boundary-invalid':
    case 'path-invalid':
    case 'path-outside-project':
    case 'path-not-portable':
    case 'unsupported-file-type':
      return 'path';
    case 'offline':
    case 'host-stopped':
    case 'endpoint-unreachable':
    case 'local-network-permission-required':
    case 'tls-untrusted':
    case 'tls-ca-mismatch':
    case 'invitation-invalid':
    case 'invitation-expired':
    case 'invitation-revoked':
      return 'connectivity';
    case 'stale-project-selection':
    case 'working-tree-busy':
    case 'project-retired':
    case 'host-transfer-pending':
    case 'manager-responsibility-pending':
      return 'state';
    case 'repository-invalid':
    case 'repository-corrupt':
    case 'database-corrupt':
      return 'integrity';
    case 'cancelled':
    case 'durable-progress-recovery-required':
      return 'operation';
  }
}

export function collabErrorGroup(code: CollabErrorCode): CollabErrorGroup {
  return SHARED_ERROR_CODES.has(code)
    ? sharedCollabErrorGroup(code as SharedCollabErrorCode)
    : localCollabErrorGroup(code as ClaudianCollabErrorCode);
}

/** Claudian error value with application-only vocabulary layered over the shared wire errors. */
export class CollabError extends Error {
  readonly code: CollabErrorCode;
  readonly group: CollabErrorGroup;
  readonly safeContext: CollabDiagnosticContext;
  readonly recoveryActions: readonly CollabRecoveryAction[];
  declare readonly cause?: unknown;

  static [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof SharedCollabError
      || Boolean(Function.prototype[Symbol.hasInstance].call(this, value));
  }

  constructor(options: CollabErrorOptions) {
    super(`collab.error.${options.code}`);
    this.name = 'CollabError';
    this.code = options.code;
    this.group = collabErrorGroup(options.code);
    this.safeContext = Object.freeze(sanitizeCollabDiagnosticContext(options.safeContext));
    this.recoveryActions = Object.freeze([...(options.recoveryActions ?? [])]);
    if (options.cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: false,
        enumerable: false,
        value: options.cause,
        writable: false,
      });
    }
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return {
      name: this.name,
      code: this.code,
      group: this.group,
      message: this.message,
      safeContext: this.safeContext,
      recoveryActions: this.recoveryActions,
    };
  }
}
