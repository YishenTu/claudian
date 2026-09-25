import { LANAuthorityTransferClient, type LANAuthorityTransferClientOptions, type LANAuthorityTransferTrustedHost } from '@/app/collab/lan/authority-transfer/LANAuthorityTransferClient';
import { PinnedCollabHTTPClient } from '@/app/collab/lan/CollabHTTPClient';
import { ProjectControlClient } from '@/app/collab/publish/ProjectControlClient';
import type { CollabLANProjectSnapshot, CollabOperationOptions } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

/** Reads the accepted LAN target before committing claimant membership. */
export class LANAuthorityTransferTargetSnapshotReader {
  private readonly connection: LANAuthorityTransferClient;

  constructor(private readonly trust: LANAuthorityTransferTrustedHost & {
    readonly authorityGeneration: number;
  }, private readonly options: LANAuthorityTransferClientOptions = {}) {
    this.connection = new LANAuthorityTransferClient(trust, options);
  }

  get currentEndpoint(): string { return this.connection.currentEndpoint; }

  async readSnapshot(
    projectId: string,
    memberCredential: string,
    options: CollabOperationOptions = {},
  ): Promise<CollabLANProjectSnapshot> {
    if (projectId !== this.trust.projectId) throw new CollabError({ code: 'project-not-found' });
    for (let attempt = 0; ; attempt += 1) {
      try {
        const endpoint = await this.connection.resolveCurrentAuthorityEndpoint(this.trust.authorityGeneration, options);
        const control = new ProjectControlClient(new PinnedCollabHTTPClient(
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
