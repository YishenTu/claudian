import { type CollabMemberStatus } from '@claudian-collab/protocol';

import {
  COLLAB_CONTROL_OPERATION_BINDINGS,
  type CollabControlAuthentication,
} from '@/app/collab/lan/CollabControlOperationBindings';
import type {
  CollabControlAdmissionPort,
} from '@/app/collab/lan/CollabControlRouter';
import type {
  HostedLifecycleControlPort,
  HostedMembershipAdminPort,
} from '@/app/collab/lan/HostedProjectControlService';
import {
  type LanCollabControlOperationMap as CollabControlOperationMap,
  type LanCollabLifecycleControlOperation as CollabLifecycleControlOperation,
} from '@/app/collab/lan/LanCollabControlOperations';
import type {
  CollabControlDeferredResult,
  CollabControlRouteResult,
  CollabTerminalProjectService,
} from '@/app/collab/lan/routes/RouteTypes';
import { CollabError } from '@/core/collab/ClaudianCollabError';

type LifecycleRequest<Operation extends CollabLifecycleControlOperation> =
  CollabControlOperationMap[Operation]['request'];

type LifecycleGatewayInputUnion = {
  [Operation in CollabLifecycleControlOperation]: {
    readonly credential: string | null;
    readonly operation: Operation;
    readonly request: LifecycleRequest<Operation>;
  }
}[CollabLifecycleControlOperation];

export interface LifecycleGatewayInput<Operation extends CollabLifecycleControlOperation> {
  readonly credential: string | null;
  readonly operation: Operation;
  readonly request: LifecycleRequest<Operation>;
}

export interface LifecycleGatewayPort {
  execute<Operation extends CollabLifecycleControlOperation>(
    input: LifecycleGatewayInput<Operation>,
  ): Promise<CollabControlRouteResult>;
}

type LifecycleAuthentication = Exclude<CollabControlAuthentication, 'invitation'>;
export interface ActiveLifecycleGatewayOptions {
  readonly admission?: CollabControlAdmissionPort;
  readonly administration: HostedMembershipAdminPort;
  readonly authenticateMemberCredential: (
    credential: string,
    statuses: readonly CollabMemberStatus[],
  ) => Promise<{ readonly member: { readonly id: string } }>;
  readonly lifecycle: HostedLifecycleControlPort;
}

function gatewayError(reason: string): CollabError {
  return new CollabError({
    code: 'operation-failed',
    safeContext: { reason },
  });
}

function requireCredential(credential: string | null): string {
  if (!credential) {
    throw new CollabError({
      code: 'authentication-failed',
      safeContext: { reason: 'lifecycle-credential-required' },
    });
  }
  return credential;
}

function normalizeDeferred<T>(
  result: T | CollabControlDeferredResult<T>,
): CollabControlRouteResult {
  if (typeof result === 'object' && result !== null && 'response' in result) {
    return {
      ...(result.afterResponseFlushed
        ? { afterResponseFlushed: result.afterResponseFlushed }
        : {}),
      ...(result.afterResponseSettled
        ? { afterResponseSettled: result.afterResponseSettled }
        : {}),
      data: result.response,
    };
  }
  return { data: result };
}

export class ActiveLifecycleGateway implements LifecycleGatewayPort {
  constructor(private readonly options: ActiveLifecycleGatewayOptions) {}

  execute<Operation extends CollabLifecycleControlOperation>(
    input: LifecycleGatewayInput<Operation>,
  ): Promise<CollabControlRouteResult> {
    return this.executeKnown(input as LifecycleGatewayInputUnion);
  }

  private executeKnown(input: LifecycleGatewayInputUnion): Promise<CollabControlRouteResult> {
    const policy = COLLAB_CONTROL_OPERATION_BINDINGS[input.operation];
    if (policy.admission === 'terminal') {
      return Promise.reject(gatewayError('lifecycle-service-unavailable'));
    }
    const dispatch = () => this.dispatch(input, policy.authentication);
    return policy.admission === 'active'
      && this.options.admission
      ? this.options.admission.run(dispatch)
      : dispatch();
  }

  private async dispatch(
    input: LifecycleGatewayInputUnion,
    authentication: LifecycleAuthentication,
  ): Promise<CollabControlRouteResult> {
    const actorMemberId = await this.authenticate(authentication, input.credential);
    if (actorMemberId === null) {
      if (input.operation === 'getHostTransitions') {
        return { data: await this.options.lifecycle.getHostTransitions(input.request) };
      }
      throw gatewayError('lifecycle-policy-operation-mismatch');
    }
    if (input.operation === 'getHostTransitions' || input.operation === 'acknowledgeRetirement') {
      throw gatewayError('lifecycle-policy-operation-mismatch');
    }

    switch (input.operation) {
      case 'leaveProject':
        return {
          data: await this.options.administration.leaveProject(actorMemberId, input.request),
        };
      case 'promoteManager':
        return {
          data: await this.options.administration.promoteManager(actorMemberId, input.request),
        };
      case 'demoteManager':
        return {
          data: await this.options.administration.demoteManager(actorMemberId, input.request),
        };
      case 'createManagerResponsibilityOffer':
        return {
          data: await this.options.lifecycle.createManagerResponsibilityOffer(
            actorMemberId,
            input.request,
          ),
        };
      case 'getCurrentManagerResponsibilityOffer':
        return {
          data: await this.options.lifecycle.getCurrentManagerResponsibilityOffer(
            actorMemberId,
            input.request,
          ),
        };
      case 'getManagerResponsibilityOffer':
        return {
          data: await this.options.lifecycle.getManagerResponsibilityOffer(
            actorMemberId,
            input.request,
          ),
        };
      case 'acknowledgeManagerResponsibility':
        return {
          data: await this.options.lifecycle.acknowledgeManagerResponsibility(
            actorMemberId,
            input.request,
          ),
        };
      case 'declineManagerResponsibility':
        return {
          data: await this.options.lifecycle.declineManagerResponsibility(
            actorMemberId,
            input.request,
          ),
        };
      case 'cancelManagerResponsibilityOffer':
        return {
          data: await this.options.lifecycle.cancelManagerResponsibilityOffer(
            actorMemberId,
            input.request,
          ),
        };
      case 'createHostTransfer':
        return {
          data: await this.options.lifecycle.createHostTransfer(actorMemberId, input.request),
        };
      case 'acceptHostTransfer':
        return normalizeDeferred(await this.options.lifecycle.acceptHostTransfer(
          actorMemberId,
          input.request,
        ));
      case 'declineHostTransfer':
        return {
          data: await this.options.lifecycle.declineHostTransfer(actorMemberId, input.request),
        };
      case 'cancelHostTransfer':
        return {
          data: await this.options.lifecycle.cancelHostTransfer(actorMemberId, input.request),
        };
      case 'retireProject':
        return {
          data: await this.options.lifecycle.retireProject(actorMemberId, input.request),
        };
    }
    throw gatewayError('lifecycle-policy-operation-mismatch');
  }

  private async authenticate(
    authentication: LifecycleAuthentication,
    credential: string | null,
  ): Promise<string | null> {
    switch (authentication) {
      case 'public':
        return null;
      case 'terminal-member':
        throw gatewayError('lifecycle-service-unavailable');
      case 'active-member':
      case 'active-or-left': {
        const statuses = authentication === 'active-or-left'
          ? ['active', 'left'] as const
          : ['active'] as const;
        const actor = await this.options.authenticateMemberCredential(
          requireCredential(credential),
          statuses,
        );
        return actor.member.id;
      }
    }
  }
}

export class TerminalLifecycleGateway implements LifecycleGatewayPort {
  constructor(private readonly terminal: CollabTerminalProjectService) {}

  execute<Operation extends CollabLifecycleControlOperation>(
    input: LifecycleGatewayInput<Operation>,
  ): Promise<CollabControlRouteResult> {
    return this.executeKnown(input as LifecycleGatewayInputUnion);
  }

  private async executeKnown(
    input: LifecycleGatewayInputUnion,
  ): Promise<CollabControlRouteResult> {
    const policy = COLLAB_CONTROL_OPERATION_BINDINGS[input.operation];
    if (policy.authentication === 'public' && input.operation === 'getHostTransitions') {
      return { data: await this.terminal.getHostTransitions(input.request) };
    }
    if (
      policy.admission === 'terminal'
      && policy.authentication === 'terminal-member'
      && input.operation === 'acknowledgeRetirement'
    ) {
      return normalizeDeferred(await this.terminal.acknowledgeRetirement(
        requireCredential(input.credential),
        input.request,
      ));
    }
    throw gatewayError('lifecycle-service-unavailable');
  }
}
