import { CollabError } from '@/core/collab/ClaudianCollabError';
import { toError } from '@/utils/error';

export type HostedProjectAdmissionMode =
  | 'active'
  | 'quiescing'
  | 'transferred'
  | 'retired';

export interface HostedProjectAdmissionGateOptions {
  readonly drainTimeoutMs?: number;
}

const DEFAULT_DRAIN_TIMEOUT_MS = 15_000;

function admissionError(
  code:
    | 'durable-progress-recovery-required'
    | 'host-transfer-pending'
    | 'operation-failed'
    | 'operation-timeout'
    | 'project-retired',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'operation-timeout'
      || code === 'durable-progress-recovery-required'
      ? ['resume', 'open-diagnostics']
      : [],
    safeContext: { reason },
  });
}

export class HostedProjectAdmissionGate {
  private readonly drainTimeoutMs: number;
  private readonly admitted = new Set<Promise<unknown>>();
  private currentMode: HostedProjectAdmissionMode = 'active';
  private pendingTerminal: Extract<
    HostedProjectAdmissionMode,
    'retired' | 'transferred'
  > | null = null;

  constructor(options: HostedProjectAdmissionGateOptions = {}) {
    this.drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.drainTimeoutMs) || this.drainTimeoutMs < 1) {
      throw admissionError('operation-failed', 'host-admission-timeout-invalid');
    }
  }

  get admittedCount(): number {
    return this.admitted.size;
  }

  get mode(): HostedProjectAdmissionMode {
    return this.currentMode;
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.currentMode !== 'active') {
      return Promise.reject(admissionError(
        this.pendingTerminal === 'transferred' || this.currentMode === 'transferred'
          ? 'host-transfer-pending'
          : 'project-retired',
        `host-project-${this.currentMode}`,
      ));
    }
    const started = Promise.resolve()
      .then(operation)
      .catch((error: unknown) => {
        throw toError(error, 'Hosted Project operation failed.');
      });
    const tracked = started.finally(() => {
      this.admitted.delete(tracked);
    });
    this.admitted.add(tracked);
    return tracked;
  }

  async quiesceAndDrain(
    target: Extract<HostedProjectAdmissionMode, 'retired' | 'transferred'> = 'retired',
  ): Promise<void> {
    if (this.currentMode === 'active') {
      this.currentMode = 'quiescing';
      this.pendingTerminal = target;
    }
    if (this.currentMode === 'quiescing' && this.pendingTerminal !== target) {
      throw admissionError(
        'durable-progress-recovery-required',
        'host-project-terminal-transition-conflict',
      );
    }
    if (this.currentMode !== 'quiescing') return;
    const pending = [...this.admitted];
    if (pending.length === 0) return;
    let timer: number | null = null;
    try {
      await Promise.race([
        Promise.allSettled(pending).then(() => undefined),
        new Promise<never>((_resolve, reject) => {
          timer = window.setTimeout(() => reject(admissionError(
            'operation-timeout',
            'host-project-admission-drain-timeout',
          )), this.drainTimeoutMs);
        }),
      ]);
    } finally {
      if (timer !== null) window.clearTimeout(timer);
    }
  }

  reopen(): void {
    if (this.currentMode === 'active') return;
    if (this.currentMode !== 'quiescing') {
      throw admissionError(
        'durable-progress-recovery-required',
        'host-project-terminal-transition-cannot-reopen',
      );
    }
    this.currentMode = 'active';
    this.pendingTerminal = null;
  }

  commitTerminal(mode: Extract<HostedProjectAdmissionMode, 'retired' | 'transferred'>): void {
    if (this.currentMode === mode) return;
    if (
      this.currentMode !== 'quiescing'
      || this.pendingTerminal !== mode
      || this.admitted.size > 0
    ) {
      throw admissionError(
        'durable-progress-recovery-required',
        'host-project-terminal-transition-not-drained',
      );
    }
    this.currentMode = mode;
  }
}
