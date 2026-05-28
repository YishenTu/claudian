import type { TabId } from '../tabs/types';

export interface OrchestratorServiceDeps {
  sendToTab: (tabId: TabId, message: string) => void;
}

interface WorkerMeta {
  orchestratorTabId: TabId;
  description: string;
  done: boolean;
}

export class OrchestratorService {
  private deps: OrchestratorServiceDeps;
  private workerSets = new Map<TabId, Set<TabId>>();
  private workerMeta = new Map<TabId, WorkerMeta>();

  constructor(deps: OrchestratorServiceDeps) {
    this.deps = deps;
  }

  registerWorker(orchestratorTabId: TabId, workerTabId: TabId, description: string): void {
    if (!this.workerSets.has(orchestratorTabId)) {
      this.workerSets.set(orchestratorTabId, new Set());
    }
    this.workerSets.get(orchestratorTabId)!.add(workerTabId);
    this.workerMeta.set(workerTabId, { orchestratorTabId, description, done: false });
  }

  reportResult(workerTabId: TabId, result: string, isError = false): void {
    const meta = this.workerMeta.get(workerTabId);
    if (!meta || meta.done) return;
    meta.done = true;

    // Orchestrator may have been closed; guard against sending to a dead tab.
    if (!this.workerSets.has(meta.orchestratorTabId)) return;

    const label = isError
      ? `Worker '${meta.description}' failed: ${result}`
      : `Worker '${meta.description}' finished: ${result}`;
    this.deps.sendToTab(meta.orchestratorTabId, label);
    // Intentional: synthesis fires even when all workers failed or were closed,
    // so the orchestrator can compose a meaningful response from the failure messages.
    this.checkAllDone(meta.orchestratorTabId);
  }

  handleTabClosed(tabId: TabId): void {
    const meta = this.workerMeta.get(tabId);
    if (meta && !meta.done) {
      meta.done = true;
      if (this.workerSets.has(meta.orchestratorTabId)) {
        this.deps.sendToTab(
          meta.orchestratorTabId,
          `Worker '${meta.description}' was closed before completing.`,
        );
        this.checkAllDone(meta.orchestratorTabId);
      }
    }
    // Clean up meta for this tab (whether worker or not-yet-done orchestrator).
    this.workerMeta.delete(tabId);

    // If this is an orchestrator tab, clean up all its workers' meta too.
    const fleet = this.workerSets.get(tabId);
    if (fleet) {
      for (const wId of fleet) this.workerMeta.delete(wId);
      this.workerSets.delete(tabId);
    }
  }

  getOrchestratorTabId(workerTabId: TabId): TabId | null {
    return this.workerMeta.get(workerTabId)?.orchestratorTabId ?? null;
  }

  private checkAllDone(orchestratorTabId: TabId): void {
    const workers = this.workerSets.get(orchestratorTabId);
    if (!workers) return;
    const allDone = [...workers].every((id) => this.workerMeta.get(id)?.done === true);
    if (allDone) {
      this.deps.sendToTab(orchestratorTabId, 'All workers have reported. Please synthesize.');
      // Clean up fleet state after synthesis fires.
      for (const wId of workers) this.workerMeta.delete(wId);
      this.workerSets.delete(orchestratorTabId);
    }
  }
}
