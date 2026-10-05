import type { TabId } from '@/features/chat/tabs/ChatTab';

type ActivationStartedCallback = (previousTabId: TabId | null) => void;

type PendingTabSwitchRequest = {
  onActivationStarted?: ActivationStartedCallback;
  promise: Promise<void>;
  reject: (error: unknown) => void;
  requestRevision: number;
  required: boolean;
  resolve: () => void;
  tabId: TabId;
};

type TabSwitchIntent = {
  requestRevision: number;
  tabId: TabId;
};

export interface TabSwitchSchedulerHost {
  /** Whether the target is a live member right now; checked before a switch claims the slot. */
  canStart(tabId: TabId): boolean;
  isDestroyed(): boolean;
  getActiveTabId(): TabId | null;
  /**
   * Activates the target. Calls `onActivationStarted` synchronously with the previous active
   * tab before its first await, and settles only after its own commit bookkeeping.
   */
  executeSwitch(tabId: TabId, onActivationStarted?: ActivationStartedCallback): Promise<void>;
}

/**
 * Serializes tab activation. One switch runs at a time; optional requests collapse to the
 * latest intent while required admission switches keep their own settlement.
 */
export class TabSwitchScheduler {
  #isSwitching = false;
  #pendingRequests: PendingTabSwitchRequest[] = [];
  readonly #idleWaiters = new Set<() => void>();
  #requestRevision = 0;
  #latestIntent: TabSwitchIntent | null = null;

  constructor(private readonly host: TabSwitchSchedulerHost) {}

  get requestRevision(): number {
    return this.#requestRevision;
  }

  /** Records the newest activation intent; a superseded in-flight switch re-queues it. */
  reserveIntent(tabId: TabId): number {
    const requestRevision = ++this.#requestRevision;
    this.#latestIntent = { requestRevision, tabId };
    return requestRevision;
  }

  async request(
    tabId: TabId,
    required: boolean,
    requestRevision: number,
    onActivationStarted?: ActivationStartedCallback,
  ): Promise<void> {
    if (!this.host.canStart(tabId)) {
      return;
    }

    if (this.#isSwitching) {
      return this.#queue(tabId, required, requestRevision, onActivationStarted);
    }

    this.#isSwitching = true;
    try {
      await this.host.executeSwitch(tabId, onActivationStarted);
    } finally {
      this.#isSwitching = false;
      this.#queueLatestIntent(requestRevision);
      this.#startPending();
    }
  }

  async waitForIdle(): Promise<void> {
    while (this.#isSwitching || this.#pendingRequests.length > 0) {
      await new Promise<void>((resolve) => {
        this.#idleWaiters.add(resolve);
      });
    }
  }

  #queue(
    tabId: TabId,
    required: boolean,
    requestRevision: number,
    onActivationStarted?: ActivationStartedCallback,
  ): Promise<void> {
    const existingRequest = this.#pendingRequests.find(request => (
      request.requestRevision === requestRevision
      && request.tabId === tabId
      && request.required === required
    ));
    if (existingRequest) return existingRequest.promise;

    if (!required) {
      const newerPendingRequest = this.#pendingRequests.find(request => (
        !request.required && request.requestRevision > requestRevision
      ));
      if (newerPendingRequest) return Promise.resolve();

      const retainedRequests: PendingTabSwitchRequest[] = [];
      for (const pendingRequest of this.#pendingRequests) {
        if (pendingRequest.required || pendingRequest.requestRevision > requestRevision) {
          retainedRequests.push(pendingRequest);
        } else {
          pendingRequest.resolve();
        }
      }
      this.#pendingRequests = retainedRequests;
    }

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.#pendingRequests.push({
      onActivationStarted,
      promise,
      reject,
      requestRevision,
      required,
      resolve,
      tabId,
    });
    this.#pendingRequests.sort((left, right) => (
      left.requestRevision - right.requestRevision
    ));
    return promise;
  }

  #queueLatestIntent(completedRequestRevision: number): void {
    const latestIntent = this.#latestIntent;
    if (
      this.host.isDestroyed()
      || !latestIntent
      || latestIntent.requestRevision <= completedRequestRevision
      || latestIntent.tabId === this.host.getActiveTabId()
    ) {
      return;
    }

    if (!this.host.canStart(latestIntent.tabId)) return;
    if (this.#pendingRequests.some(request => (
      request.requestRevision === latestIntent.requestRevision
      && request.tabId === latestIntent.tabId
    ))) {
      return;
    }
    void this.#queue(
      latestIntent.tabId,
      false,
      latestIntent.requestRevision,
    ).catch(() => undefined);
  }

  #startPending(): void {
    const pendingRequest = this.#pendingRequests.shift() ?? null;
    if (!pendingRequest) {
      this.#resolveIdleWaitersIfIdle();
      return;
    }
    if (pendingRequest.tabId === this.host.getActiveTabId()) {
      pendingRequest.resolve();
      this.#startPending();
      return;
    }

    const continueAfterSettlement = (): void => {
      if (!this.#isSwitching && this.#pendingRequests.length > 0) {
        this.#startPending();
      } else {
        this.#resolveIdleWaitersIfIdle();
      }
    };
    void this.request(
      pendingRequest.tabId,
      pendingRequest.required,
      pendingRequest.requestRevision,
      pendingRequest.onActivationStarted,
    ).then(
      () => {
        pendingRequest.resolve();
        continueAfterSettlement();
      },
      (error) => {
        pendingRequest.reject(error);
        continueAfterSettlement();
      },
    );
  }

  #resolveIdleWaitersIfIdle(): void {
    if (this.#isSwitching || this.#pendingRequests.length > 0) return;

    const waiters = [...this.#idleWaiters];
    this.#idleWaiters.clear();
    for (const resolve of waiters) {
      resolve();
    }
  }
}
