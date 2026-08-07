import type { ProviderExecutionErrorCategory } from '../execution/ProviderExecutionEvent';
import type { ProviderId } from '../types/provider';
import type { ProviderReadinessSnapshot } from './ProviderReadiness';

export type ProviderDiagnosticErrorCategory =
  | 'not-configured'
  | 'cli-not-found'
  | 'cli-start-failed'
  | 'session-resume-failed'
  | 'model-unavailable'
  | 'permission-denied'
  | 'timeout'
  | 'rate-limited'
  | 'protocol-error'
  | 'authentication'
  | 'provider'
  | 'unknown';

export interface ProviderDiagnosticError {
  category: ProviderDiagnosticErrorCategory;
  message: string;
  recoverable: boolean;
}

export interface ProviderDiagnosticRuntime {
  status: 'idle' | 'starting' | 'running' | 'failed';
  sessionId?: string;
  generation?: number;
  lastError?: ProviderDiagnosticError;
}

export interface ProviderDiagnosticEnvironment {
  platform: string;
  cliPathConfigured: boolean;
  cliVersion?: string;
  workingDirectoryAvailable: boolean;
}

export interface ProviderDiagnosticCollectorContext {
  settings: Record<string, unknown>;
  selectedModel?: string | null;
  resolveCliPath?: () => Promise<string | null>;
}

export interface ProviderDiagnosticData {
  readiness?: ProviderReadinessSnapshot;
  environment?: Partial<ProviderDiagnosticEnvironment>;
}

export type ProviderDiagnosticCollector = (
  context: ProviderDiagnosticCollectorContext,
) => ProviderDiagnosticData | Promise<ProviderDiagnosticData>;

export interface ProviderDiagnosticSnapshot {
  createdAt: number;
  providerId: ProviderId;
  readiness: ProviderReadinessSnapshot;
  runtime: ProviderDiagnosticRuntime;
  environment: ProviderDiagnosticEnvironment;
}

export interface ProviderDiagnosticReport {
  createdAt: number;
  providerId: ProviderId;
  error: ProviderDiagnosticError;
  platform: string;
  runtimeStatus: ProviderDiagnosticRuntime['status'];
  readiness?: ProviderReadinessSnapshot;
  environment?: ProviderDiagnosticEnvironment;
}

export function createProviderDiagnosticReport(
  providerId: ProviderId,
  error: ProviderDiagnosticError,
  options: {
    platform?: string;
    runtimeStatus?: ProviderDiagnosticRuntime['status'];
    readiness?: ProviderReadinessSnapshot;
    environment?: ProviderDiagnosticEnvironment;
    createdAt?: number;
  } = {},
): ProviderDiagnosticReport {
  return {
    createdAt: options.createdAt ?? Date.now(),
    providerId,
    error,
    platform: options.platform ?? 'unknown',
    runtimeStatus: options.runtimeStatus ?? 'failed',
    readiness: options.readiness,
    environment: options.environment,
  };
}

const SECRET_PATTERNS = [
  /(bearer\s+)[^\s,;]+/gi,
  /((?:api[\s_-]?key|auth(?:entication)?[\s_-]?token|access[\s_-]?token)\s*[:=]\s*)[^\s,;]+/gi,
  /((?:ANTHROPIC|OPENAI|CODEX|GEMINI|XAI)[A-Z0-9_]*(?:KEY|TOKEN|SECRET)[A-Z0-9_]*\s*=\s*)[^\s,;]+/gi,
  /\b(?:sk|key|token)-[A-Za-z0-9_-]{12,}\b/g,
] as const;

/** Removes common credentials before a diagnostic message leaves memory. */
export function sanitizeDiagnosticMessage(message: string): string {
  return SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, '$1[REDACTED]'),
    message,
  );
}

export function stringifyDiagnosticError(error: unknown): string {
  if (error instanceof Error) {
    if (error.cause !== undefined
      && (!error.message.trim() || error.message.includes('[object Object]'))) {
      return stringifyDiagnosticError(error.cause);
    }
    return typeof error.message === 'string' && error.message.trim()
      ? error.message
      : error.name;
  }
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const candidate = record.message ?? record.error ?? record.detail;
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
    try {
      return JSON.stringify(error);
    } catch {
      return 'Provider execution failed.';
    }
  }
  return String(error ?? 'Provider execution failed.');
}

export function classifyProviderError(
  message: string,
  hint?: ProviderExecutionErrorCategory,
): ProviderDiagnosticErrorCategory {
  const normalized = message.toLowerCase();
  if (hint === 'authentication') return 'authentication';
  if (hint === 'provider-session-missing') return 'session-resume-failed';
  if (hint === 'configuration') {
    return /not found|enoent|cli|executable|command/i.test(normalized)
      ? 'cli-not-found'
      : 'not-configured';
  }
  if (hint === 'process-exited') return 'cli-start-failed';
  if (hint === 'transport') return 'protocol-error';

  if (/\b401\b|\b403\b|unauthorized|authentication|invalid api key|invalid token/.test(normalized)) {
    return 'authentication';
  }
  if (/\b429\b|rate limit|too many requests/.test(normalized)) return 'rate-limited';
  if (/timeout|timed out|deadline exceeded/.test(normalized)) return 'timeout';
  if (/permission denied|access denied|eacces/.test(normalized)) return 'permission-denied';
  if (/model.*(not found|unavailable)|unknown model/.test(normalized)) return 'model-unavailable';
  if (/session.*(not found|missing)|thread.*(not found|missing)|resume/.test(normalized)) {
    return 'session-resume-failed';
  }
  if (/\bcli\b.*(?:not found|unavailable)|(?:not found|unavailable).*\bcli\b|command not found|no such file or directory|\benoent\b/.test(normalized)) {
    return 'cli-not-found';
  }
  if (/protocol|json-rpc|handshake|parse error/.test(normalized)) return 'protocol-error';
  if (/spawn|exited|enoent|executable/.test(normalized)) return 'cli-start-failed';
  return 'unknown';
}

export function createProviderDiagnosticError(
  message: unknown,
  options: {
    category?: ProviderDiagnosticErrorCategory;
    hint?: ProviderExecutionErrorCategory;
    recoverable?: boolean;
  } = {},
): ProviderDiagnosticError {
  const normalizedMessage = stringifyDiagnosticError(message);
  return {
    category: options.category ?? classifyProviderError(normalizedMessage, options.hint),
    message: sanitizeDiagnosticMessage(normalizedMessage),
    recoverable: options.recoverable ?? true,
  };
}

export function formatProviderDiagnosticNotice(error: ProviderDiagnosticError): string {
  return `[${error.category}] ${error.message}`;
}
