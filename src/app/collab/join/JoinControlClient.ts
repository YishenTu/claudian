import type { CollabMember } from '@claudian-collab/protocol';

import {
  COLLAB_CONTROL_OPERATION_BINDINGS,
  collabControlOperationPath,
} from '@/app/collab/lan/CollabControlOperationBindings';
import type {
  CollabHttpOperationOptions,
  CollabJsonRequest,
  PinnedCollabHttpClient,
} from '@/app/collab/lan/CollabHttpClient';
import { lanCollabControlOperationCodec } from '@/app/collab/lan/LanCollabControlOperationCodecs';
import type { LanCollabJoinAttempt as CollabJoinAttempt } from '@/app/collab/lan/LanCollabControlOperations';
import type { CollabProject } from '@/core/collab';

export interface JoinActivationSnapshot {
  readonly currentMember: CollabMember;
  readonly eventSequence: number;
  readonly project: CollabProject;
}

export class JoinControlClient {
  constructor(private readonly client: PinnedCollabHttpClient) {}

  createJoinAttempt(
    input: {
      readonly displayName: string;
      readonly invitationSecret: string;
      readonly joinAttemptId: string;
      readonly projectId: string;
    },
    options: CollabHttpOperationOptions = {},
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
    options: CollabHttpOperationOptions = {},
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

  private request<T>(request: CollabJsonRequest<T>): CollabJsonRequest<T> {
    return request;
  }
}
