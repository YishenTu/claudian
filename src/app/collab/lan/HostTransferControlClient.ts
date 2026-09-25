import {
  COLLAB_CONTROL_OPERATION_BINDINGS,
  collabControlOperationPath,
} from '@/app/collab/lan/CollabControlOperationBindings';
import type {
  CollabHTTPOperationOptions,
  CollabJSONRequest,
} from '@/app/collab/lan/CollabHTTPClient';
import { lanCollabControlOperationCodec } from '@/app/collab/lan/LANCollabControlOperationCodecs';
import type {
  AcceptHostTransferRequest,
  CancelHostTransferRequest,
  CreateHostTransferRequest,
  DeclineHostTransferRequest,
} from '@/app/collab/lan/LANCollabControlOperations';
import type { LANCollabControlOperationMap } from '@/app/collab/lan/LANCollabControlOperations';
import type { CollabHostTransferSummary } from '@/core/collab';

export interface HostTransferControlTransport {
  requestWithMember<T>(
    request: CollabJSONRequest<T>,
    memberCredential: string,
    options?: CollabHTTPOperationOptions,
  ): Promise<T>;
}

interface HostTransferMutationInput<Request> {
  readonly memberCredential: string;
  readonly request: Request;
  readonly signal?: AbortSignal;
}

export class HostTransferControlClient {
  constructor(private readonly transport: HostTransferControlTransport) {}

  create(input: HostTransferMutationInput<CreateHostTransferRequest>): Promise<CollabHostTransferSummary> {
    return this.mutate('createHostTransfer', input);
  }

  accept(input: HostTransferMutationInput<AcceptHostTransferRequest>): Promise<CollabHostTransferSummary> {
    return this.mutate(
      'acceptHostTransfer',
      input,
    );
  }

  decline(input: HostTransferMutationInput<DeclineHostTransferRequest>): Promise<CollabHostTransferSummary> {
    return this.mutate(
      'declineHostTransfer',
      input,
    );
  }

  cancel(input: HostTransferMutationInput<CancelHostTransferRequest>): Promise<CollabHostTransferSummary> {
    return this.mutate(
      'cancelHostTransfer',
      input,
    );
  }

  private mutate<Operation extends
    'acceptHostTransfer' | 'cancelHostTransfer' | 'createHostTransfer' | 'declineHostTransfer'>(
    operation: Operation,
    input: HostTransferMutationInput<LANCollabControlOperationMap[Operation]['request']>,
  ): Promise<CollabHostTransferSummary> {
    return this.transport.requestWithMember({
      body: input.request,
      decode: lanCollabControlOperationCodec(operation).decodeResponse,
      idempotencyKey: input.request.idempotencyKey,
      method: COLLAB_CONTROL_OPERATION_BINDINGS[operation].method,
      path: collabControlOperationPath(operation, input.request.projectId, {
        transferId: 'transferId' in input.request ? input.request.transferId : '',
      }),
    }, input.memberCredential, input.signal ? { signal: input.signal } : {});
  }
}
