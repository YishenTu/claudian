import type {
  HostTransitionProofClientPort,
} from '@/app/collab/HostTransitionCandidateResolver';
import {
  COLLAB_CONTROL_OPERATION_BINDINGS,
  collabControlOperationPath,
} from '@/app/collab/lan/CollabControlOperationBindings';
import {
  CollabHTTPClient,
  type CollabHTTPOperationOptions,
  type CollabTrustedEndpointCandidate,
} from '@/app/collab/lan/CollabHTTPClient';
import { lanCollabControlOperationCodec } from '@/app/collab/lan/LANCollabControlOperationCodecs';
import type { CollabHostTrustTransitionProof } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

function decodeProofs(
  value: unknown,
  projectId: string,
): readonly CollabHostTrustTransitionProof[] {
  const response = lanCollabControlOperationCodec('getHostTransitions').decodeResponse(value);
  if (response.projectId !== projectId) {
    throw new CollabError({
      code: 'protocol-payload-invalid',
      safeContext: { reason: 'host-transition-project-mismatch' },
    });
  }
  return response.proofs;
}

export interface LANHostTransitionProofClientOptions {
  readonly createHttpClient?: () => Pick<
    CollabHTTPClient,
    'bootstrapPublicEndpoint'
  >;
}

export class LANHostTransitionProofClient implements HostTransitionProofClientPort {
  private readonly createHttpClient: () => Pick<
    CollabHTTPClient,
    'bootstrapPublicEndpoint'
  >;

  constructor(options: LANHostTransitionProofClientOptions = {}) {
    this.createHttpClient = options.createHttpClient ?? (() => new CollabHTTPClient({
      read: async () => null,
      save: async () => 'ca-mismatch',
    }));
  }

  async fetchHostTransitions(
    candidate: CollabTrustedEndpointCandidate,
    options: CollabHTTPOperationOptions = {},
  ): Promise<readonly CollabHostTrustTransitionProof[]> {
    const pinned = await this.createHttpClient().bootstrapPublicEndpoint(candidate, options);
    return pinned.requestPublic({
      decode: value => decodeProofs(value, candidate.projectId),
      method: COLLAB_CONTROL_OPERATION_BINDINGS.getHostTransitions.method,
      path: collabControlOperationPath('getHostTransitions', candidate.projectId),
    }, options);
  }
}
