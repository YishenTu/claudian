import type { CollabMemberId, CollabProjectId } from '@claudian-collab/protocol';

import type { ProjectRetirementAuthorityRequest } from '@/app/collab/authority/ProjectRetirementAuthorityService';
import type { CollabRetirementResult } from '@/core/collab';

export interface ProjectRetirementAdmissionPort {
  quiesceAndDrain(projectId: CollabProjectId): Promise<void>;
  resume(projectId: CollabProjectId): Promise<void>;
}

export interface ProjectRetirementAuthorityPort {
  inspectDurableResult(
    actorMemberId: CollabMemberId,
    request: ProjectRetirementAuthorityRequest,
  ): Promise<{
    readonly matchesRequest: boolean;
    readonly result: CollabRetirementResult;
  } | null>;
  retire(
    actorMemberId: CollabMemberId,
    request: ProjectRetirementAuthorityRequest,
  ): Promise<CollabRetirementResult>;
}

export interface ProjectRetirementTerminalPort {
  activate(result: CollabRetirementResult): Promise<void>;
}

export interface ProjectRetirementDeliveryPort {
  deliver(result: CollabRetirementResult): Promise<void>;
}

export interface ProjectRetirementActiveResourcesPort {
  teardown(projectId: CollabProjectId): Promise<void>;
}

export class ProjectRetirementCoordinator {
  private readonly operations = new Map<CollabProjectId, Promise<CollabRetirementResult>>();

  constructor(
    private readonly admission: ProjectRetirementAdmissionPort,
    private readonly authority: ProjectRetirementAuthorityPort,
    private readonly terminal: ProjectRetirementTerminalPort,
    private readonly delivery: ProjectRetirementDeliveryPort,
    private readonly activeResources: ProjectRetirementActiveResourcesPort,
  ) {}

  retire(
    actorMemberId: CollabMemberId,
    request: ProjectRetirementAuthorityRequest,
  ): Promise<CollabRetirementResult> {
    const existing = this.operations.get(request.projectId);
    if (existing) return existing;
    const pending = this.retireUnlocked(actorMemberId, request);
    this.operations.set(request.projectId, pending);
    const clear = () => {
      if (this.operations.get(request.projectId) === pending) {
        this.operations.delete(request.projectId);
      }
    };
    void pending.then(clear, clear);
    return pending;
  }

  private async retireUnlocked(
    actorMemberId: CollabMemberId,
    request: ProjectRetirementAuthorityRequest,
  ): Promise<CollabRetirementResult> {
    await this.admission.quiesceAndDrain(request.projectId);
    let result: CollabRetirementResult;
    try {
      result = await this.authority.retire(actorMemberId, request);
    } catch (error) {
      const durable = await this.authority.inspectDurableResult(actorMemberId, request);
      if (durable === null) {
        await this.admission.resume(request.projectId).catch(() => undefined);
        throw error;
      }
      await this.finishRetirement(durable.result);
      if (!durable.matchesRequest) throw error;
      return durable.result;
    }
    return this.finishRetirement(result);
  }

  private async finishRetirement(
    result: CollabRetirementResult,
  ): Promise<CollabRetirementResult> {
    await this.terminal.activate(result);
    // Delivery updates client projections and may run local cleanup, but the
    // authority is already terminal. A local failure must not leave the active
    // route registered in front of the durable terminal responder.
    void this.delivery.deliver(result).catch(() => undefined);
    await this.activeResources.teardown(result.projectId);
    return result;
  }
}
