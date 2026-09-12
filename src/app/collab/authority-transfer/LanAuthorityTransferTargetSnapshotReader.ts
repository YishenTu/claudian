import { LanAuthorityTransferClient, type LanAuthorityTransferClientOptions, type LanAuthorityTransferTrustedHost } from '@/app/collab/lan/authority-transfer/LanAuthorityTransferClient';
import { PinnedCollabHttpClient } from '@/app/collab/lan/CollabHttpClient';
import { ProjectControlClient } from '@/app/collab/publish/ProjectControlClient';
import type { CollabLanProjectSnapshot, CollabOperationOptions } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

/** Reads the accepted LAN target before committing claimant membership. */
export class LanAuthorityTransferTargetSnapshotReader {
  private readonly connection: LanAuthorityTransferClient;

  constructor(private readonly trust: LanAuthorityTransferTrustedHost & {
    readonly authorityGeneration: number;
  }, private readonly options: LanAuthorityTransferClientOptions = {}) {
    this.connection = new LanAuthorityTransferClient(trust, options);
  }

  get currentEndpoint(): string { return this.connection.currentEndpoint; }

  async readSnapshot(
    projectId: string,
    memberCredential: string,
    options: CollabOperationOptions = {},
  ): Promise<CollabLanProjectSnapshot> {
    if (projectId !== this.trust.projectId) throw new CollabError({ code: 'project-not-found' });
    for (let attempt = 0; ; attempt += 1) {
      try {
        const endpoint = await this.connection.resolveCurrentAuthorityEndpoint(this.trust.authorityGeneration, options);
        const control = new ProjectControlClient(new PinnedCollabHttpClient(
          { ...this.trust, endpoint }, this.options.timeoutMs ?? 10_000,
        ));
        const snapshot = await control.readSnapshot(projectId, memberCredential, options);
        await this.connection.resolveCurrentAuthorityEndpoint(this.trust.authorityGeneration, options);
        return snapshot;
      } catch (error) {
        if (attempt > 0 || !(error instanceof CollabError)
          || (error.code !== 'endpoint-unreachable' && error.code !== 'operation-timeout')) throw error;
      }
    }
  }
}
