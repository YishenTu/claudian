import type {
  HostTransitionProofClientPort,
} from '@/app/collab/HostTransitionCandidateResolver';
import {
  COLLAB_CONTROL_OPERATION_BINDINGS,
  collabControlOperationPath,
} from '@/app/collab/lan/CollabControlOperationBindings';
import {
  CollabHttpClient,
  type CollabHttpOperationOptions,
  type CollabTrustedEndpointCandidate,
} from '@/app/collab/lan/CollabHttpClient';
import { lanCollabControlOperationCodec } from '@/app/collab/lan/LanCollabControlOperationCodecs';
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

export interface LanHostTransitionProofClientOptions {
  readonly createHttpClient?: () => Pick<
    CollabHttpClient,
    'bootstrapPublicEndpoint'
  >;
}

export class LanHostTransitionProofClient implements HostTransitionProofClientPort {
  private readonly createHttpClient: () => Pick<
    CollabHttpClient,
    'bootstrapPublicEndpoint'
  >;

  constructor(options: LanHostTransitionProofClientOptions = {}) {
    this.createHttpClient = options.createHttpClient ?? (() => new CollabHttpClient({
      read: async () => null,
      save: async () => 'ca-mismatch',
    }));
  }

  async fetchHostTransitions(
    candidate: CollabTrustedEndpointCandidate,
    options: CollabHttpOperationOptions = {},
  ): Promise<readonly CollabHostTrustTransitionProof[]> {
    const pinned = await this.createHttpClient().bootstrapPublicEndpoint(candidate, options);
    return pinned.requestPublic({
      decode: value => decodeProofs(value, candidate.projectId),
      method: COLLAB_CONTROL_OPERATION_BINDINGS.getHostTransitions.method,
      path: collabControlOperationPath('getHostTransitions', candidate.projectId),
    }, options);
  }
}
