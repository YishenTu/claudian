import type { CollabMember } from '@claudian-collab/protocol';

import {
  COLLAB_CONTROL_OPERATION_BINDINGS,
  collabControlOperationPath,
} from '@/app/collab/lan/CollabControlOperationBindings';
import type {
  CollabHTTPOperationOptions,
  CollabJSONRequest,
  PinnedCollabHTTPClient,
} from '@/app/collab/lan/CollabHTTPClient';
import { lanCollabControlOperationCodec } from '@/app/collab/lan/LANCollabControlOperationCodecs';
import type { LANCollabJoinAttempt as CollabJoinAttempt } from '@/app/collab/lan/LANCollabControlOperations';
import type { CollabLANProject } from '@/core/collab';

export interface JoinActivationSnapshot {
  readonly currentMember: CollabMember;
  readonly eventSequence: number;
  readonly project: CollabLANProject;
}

export class JoinControlClient {
  constructor(private readonly client: PinnedCollabHTTPClient) {}

  createJoinAttempt(
    input: {
      readonly displayName: string;
      readonly invitationSecret: string;
      readonly joinAttemptId: string;
      readonly projectId: string;
    },
    options: CollabHTTPOperationOptions = {},
  ): Promise<CollabJoinAttempt> {
    return this.client.requestWithInvitation(this.request({
      body: {
        displayName: input.displayName,
        joinAttemptId: input.joinAttemptId,
        projectId: input.projectId,
      },
      decode: value => lanCollabControlOperationCodec('createJoinAttempt')
        .decodeResponse(value).joinAttempt,
      method: COLLAB_CONTROL_OPERATION_BINDINGS.createJoinAttempt.method,
      path: collabControlOperationPath('createJoinAttempt', input.projectId),
    }), input.invitationSecret, options);
  }

  activateJoinAttempt(
    input: {
      readonly joinAttemptId: string;
      readonly memberCredential: string;
      readonly projectId: string;
    },
    options: CollabHTTPOperationOptions = {},
  ): Promise<JoinActivationSnapshot> {
    const idempotencyKey = `activate-${input.joinAttemptId}`;
    return this.client.requestWithMember(this.request({
      body: {
        idempotencyKey,
        joinAttemptId: input.joinAttemptId,
        projectId: input.projectId,
      },
      decode: value => {
        const snapshot = lanCollabControlOperationCodec('activateJoinAttempt')
          .decodeResponse(value);
        return {
          currentMember: snapshot.currentMember,
          eventSequence: snapshot.eventSequence,
          project: snapshot.project,
        };
      },
      idempotencyKey,
      method: COLLAB_CONTROL_OPERATION_BINDINGS.activateJoinAttempt.method,
      path: collabControlOperationPath('activateJoinAttempt', input.projectId, {
        joinAttemptId: input.joinAttemptId,
      }),
    }), input.memberCredential, options);
  }

  private request<T>(request: CollabJSONRequest<T>): CollabJSONRequest<T> {
    return request;
  }
}
