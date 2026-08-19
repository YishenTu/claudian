export const COLLAB_ERROR_CODES = Object.freeze([
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
] as const);

export type CollabErrorCode = typeof COLLAB_ERROR_CODES[number];

export type CollabErrorGroup =
  | 'setup'
  | 'path'
  | 'authorization'
  | 'state'
  | 'integrity'
  | 'operation';

const COLLAB_RECOVERY_ACTIONS = Object.freeze([
  'retry',
  'review-conflicts',
  'request-access',
] as const);

export type CollabRecoveryAction = typeof COLLAB_RECOVERY_ACTIONS[number];

const COLLAB_ERROR_CODE_SET: ReadonlySet<string> = new Set(COLLAB_ERROR_CODES);
const COLLAB_RECOVERY_ACTION_SET: ReadonlySet<string> = new Set(COLLAB_RECOVERY_ACTIONS);

export type CollabDiagnosticValue =
  | string
  | number
  | boolean
  | null
  | readonly CollabDiagnosticValue[]
  | { readonly [key: string]: CollabDiagnosticValue };

export type CollabDiagnosticContext = Readonly<Record<string, CollabDiagnosticValue>>;

type SafeContextRule = 'id' | 'number' | 'path' | 'timestamp' | 'token';

const SAFE_CONTEXT_RULES = Object.freeze({
  endpoint: 'path',
  exitCode: 'number',
  field: 'token',
  kind: 'token',
  limit: 'number',
  operation: 'token',
  operationId: 'id',
  path: 'path',
  projectId: 'id',
  quota: 'token',
  reason: 'token',
  receivedVersion: 'number',
  recordKind: 'token',
  retiredAt: 'timestamp',
  side: 'token',
  status: 'token',
  supportedVersion: 'number',
  ticketNumber: 'number',
} as const satisfies Readonly<Record<string, SafeContextRule>>);

const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function sanitizeAllowedValue(rule: SafeContextRule, value: unknown): CollabDiagnosticValue | null {
  switch (rule) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    case 'path':
      return typeof value === 'string' ? '[PATH]' : null;
    case 'timestamp':
      return typeof value === 'string'
        && !Number.isNaN(Date.parse(value))
        && new Date(value).toISOString() === value
        ? value
        : null;
    case 'id':
      return typeof value === 'string' && SAFE_ID_PATTERN.test(value) ? value : null;
    case 'token':
      return typeof value === 'string' && SAFE_TOKEN_PATTERN.test(value) ? value : null;
  }
}

export function sanitizeCollabDiagnosticContext(
  context: Readonly<Record<string, unknown>> = {},
): CollabDiagnosticContext {
  const result: Record<string, CollabDiagnosticValue> = {};
  for (const [key, value] of Object.entries(context)) {
    const rule = SAFE_CONTEXT_RULES[key as keyof typeof SAFE_CONTEXT_RULES];
    if (!rule) continue;
    const sanitized = sanitizeAllowedValue(rule, value);
    if (sanitized !== null) result[key] = sanitized;
  }
  return result;
}

export function collabErrorGroup(code: CollabErrorCode): CollabErrorGroup {
  switch (code) {
    case 'protocol-version-unsupported':
    case 'protocol-payload-invalid':
      return 'setup';
    case 'project-not-found':
    case 'quota-exceeded':
      return 'path';
    case 'authentication-failed':
    case 'authorization-denied':
    case 'membership-revoked':
      return 'authorization';
    case 'stale-main':
    case 'stale-request-head':
    case 'personal-ref-diverged':
    case 'content-conflict':
    case 'description-required':
    case 'request-not-open':
    case 'request-head-not-pushed':
    case 'ticket-not-found':
    case 'resolving-ticket-reference-not-found':
    case 'ticket-not-open':
    case 'stale-ticket':
    case 'stale-request-metadata':
    case 'authority-not-synchronized':
    case 'idempotency-conflict':
      return 'state';
    case 'acceptance-recovery-required':
    case 'authority-integrity-error':
      return 'integrity';
    case 'operation-timeout':
    case 'operation-failed':
      return 'operation';
  }
}

export interface CollabErrorOptions {
  code: CollabErrorCode;
  safeContext?: Readonly<Record<string, unknown>>;
  recoveryActions?: readonly CollabRecoveryAction[];
  cause?: unknown;
}

export class CollabError extends Error {
  readonly code: CollabErrorCode;
  readonly group: CollabErrorGroup;
  readonly safeContext: CollabDiagnosticContext;
  readonly recoveryActions: readonly CollabRecoveryAction[];
  declare readonly cause?: unknown;

  constructor(options: CollabErrorOptions) {
    if (!COLLAB_ERROR_CODE_SET.has(options.code)) {
      throw new TypeError('Unsupported Collab error code');
    }
    if (!(options.recoveryActions ?? []).every(action => COLLAB_RECOVERY_ACTION_SET.has(action))) {
      throw new TypeError('Unsupported Collab recovery action');
    }
    super(`collab.error.${options.code}`);
    this.name = 'CollabError';
    this.code = options.code;
    this.group = collabErrorGroup(options.code);
    this.safeContext = Object.freeze(
      sanitizeCollabDiagnosticContext(options.safeContext),
    );
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
