import type { ProviderId } from '@/core/providers/types';
import type { SubagentInfo, ToolCallInfo } from '@/core/types';
import type { SubagentManager } from '@/features/chat/services/SubagentManager';

export interface SubagentHistoryRecoveryRequest {
  readonly providerId: ProviderId;
  readonly providerSessionId: string;
  readonly subagentId: string;
}

export interface AsyncSubagentHistoryRecoveryDeps {
  subagentManager: SubagentManager;
  getMessagesEl: () => HTMLElement;
  getProviderId: () => ProviderId;
  getProviderSessionId: () => string | null;
  loadSubagentToolCalls: (
    request: SubagentHistoryRecoveryRequest,
  ) => Promise<ToolCallInfo[] | undefined>;
  loadSubagentFinalResult: (
    request: SubagentHistoryRecoveryRequest,
  ) => Promise<string | null | undefined>;
  enqueueBackgroundWork: (work: () => Promise<void>) => Promise<void> | null;
  persistConversation: () => Promise<void>;
}

interface HydrationResult {
  finalResultHydrated: boolean;
  hasHydrated: boolean;
  isCurrent: boolean;
}

const ASYNC_SUBAGENT_RESULT_RETRY_DELAYS_MS = [
  200,
  600,
  1500,
] as const;

/**
 * Recovers a finished async subagent's nested tools and final result from provider history,
 * retrying the final result while the transcript catches up. Every await revalidates that the
 * same provider session still owns the subagent.
 */
export class AsyncSubagentHistoryRecovery {
  constructor(private readonly deps: AsyncSubagentHistoryRecoveryDeps) {}

  async recover(
    subagent: SubagentInfo | undefined,
    providerSessionId?: string,
  ): Promise<void> {
    if (!this.#canRecover(subagent)) return;

    const providerId = this.deps.getProviderId();
    const ownerSessionId = providerSessionId
      ?? this.deps.getProviderSessionId()
      ?? null;
    if (
      !ownerSessionId
      || !this.#owns(
        subagent,
        providerId,
        ownerSessionId,
      )
    ) return;

    const result = await this.#tryHydrate(
      subagent,
      providerId,
      ownerSessionId,
      true,
    );
    if (!result.isCurrent) return;
    if (result.hasHydrated) {
      this.deps.subagentManager.refreshAsyncSubagent(subagent);
    }
    if (!result.finalResultHydrated) {
      this.#scheduleResultRetry(
        subagent,
        providerId,
        ownerSessionId,
        0,
      );
    }
  }

  async #tryHydrate(
    subagent: SubagentInfo,
    providerId: ProviderId,
    providerSessionId: string,
    hydrateToolCalls: boolean,
  ): Promise<HydrationResult> {
    const request: SubagentHistoryRecoveryRequest = {
      providerId,
      providerSessionId,
      subagentId: subagent.agentId ?? '',
    };
    let hasHydrated = false;

    if (hydrateToolCalls && !subagent.toolCalls?.length) {
      const recoveredToolCalls = await this.deps.loadSubagentToolCalls(request);
      if (!this.#owns(subagent, providerId, providerSessionId)) {
        return {
          finalResultHydrated: false,
          hasHydrated: false,
          isCurrent: false,
        };
      }
      if (recoveredToolCalls === undefined) {
        return {
          finalResultHydrated: true,
          hasHydrated: false,
          isCurrent: true,
        };
      }
      if (recoveredToolCalls.length > 0) {
        this.deps.subagentManager.applyRecoveredData(subagent, { toolCalls: recoveredToolCalls });
        hasHydrated = true;
      }
    }

    const recoveredFinalResult = await this.deps.loadSubagentFinalResult(request);
    if (!this.#owns(subagent, providerId, providerSessionId)) {
      return {
        finalResultHydrated: false,
        hasHydrated: false,
        isCurrent: false,
      };
    }
    if (recoveredFinalResult === undefined) {
      return { finalResultHydrated: true, hasHydrated, isCurrent: true };
    }
    const finalResultHydrated = Boolean(recoveredFinalResult?.trim());
    if (finalResultHydrated && recoveredFinalResult !== subagent.result) {
      this.deps.subagentManager.applyRecoveredData(subagent, { result: recoveredFinalResult ?? undefined });
      hasHydrated = true;
    }
    return { finalResultHydrated, hasHydrated, isCurrent: true };
  }

  #canRecover(
    subagent: SubagentInfo | undefined,
  ): subagent is SubagentInfo & { agentId: string } {
    if (!subagent || subagent.mode !== 'async' || !subagent.agentId) return false;
    const status = subagent.asyncStatus ?? subagent.status;
    return status === 'completed' || status === 'error';
  }

  #owns(
    subagent: SubagentInfo,
    providerId: ProviderId,
    providerSessionId: string,
  ): boolean {
    return this.deps.getProviderId() === providerId
      && this.deps.getProviderSessionId() === providerSessionId
      && this.deps.subagentManager.getByTaskId(subagent.id) === subagent;
  }

  #scheduleResultRetry(
    subagent: SubagentInfo,
    providerId: ProviderId,
    providerSessionId: string,
    attempt: number,
  ): void {
    if (
      !subagent.agentId
      || attempt >= ASYNC_SUBAGENT_RESULT_RETRY_DELAYS_MS.length
    ) return;

    const delay = ASYNC_SUBAGENT_RESULT_RETRY_DELAYS_MS[attempt];
    const ownerWindow = this.deps.getMessagesEl().ownerDocument.defaultView
      ?? window;
    ownerWindow.setTimeout(() => {
      const work = () => this.#retryResult(
        subagent,
        providerId,
        providerSessionId,
        attempt,
      );
      void this.deps.enqueueBackgroundWork(work)?.catch(() => undefined);
    }, delay);
  }

  async #retryResult(
    subagent: SubagentInfo,
    providerId: ProviderId,
    providerSessionId: string,
    attempt: number,
  ): Promise<void> {
    if (
      !this.#canRecover(subagent)
      || !this.#owns(subagent, providerId, providerSessionId)
    ) return;

    const result = await this.#tryHydrate(
      subagent,
      providerId,
      providerSessionId,
      false,
    );
    if (!result.isCurrent) return;
    if (result.hasHydrated) {
      this.deps.subagentManager.refreshAsyncSubagent(subagent);
      await this.deps.persistConversation();
    }
    if (!result.finalResultHydrated) {
      this.#scheduleResultRetry(
        subagent,
        providerId,
        providerSessionId,
        attempt + 1,
      );
    }
  }
}
