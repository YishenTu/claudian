import {
  COLLAB_CONTROL_OPERATION_BINDINGS,
} from '@/app/collab/lan/CollabControlOperationBindings';
import type { LanCollabControlOperation } from '@/app/collab/lan/LanCollabControlOperations';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function requireOperationCredential(
  authorization: string | null,
  operation: LanCollabControlOperation,
): string {
  const authentication = COLLAB_CONTROL_OPERATION_BINDINGS[operation].authentication;
  if (authentication === 'public') {
    throw new CollabError({
      code: 'operation-failed',
      safeContext: { reason: 'public-operation-credential-requested' },
    });
  }
  const scheme = authentication === 'invitation' ? 'Claudian-Invitation' : 'Bearer';
  const prefix = `${scheme} `;
  if (!authorization?.startsWith(prefix)) {
    throw new CollabError({
      code: 'authentication-failed',
      safeContext: { reason: 'authorization-header-invalid' },
    });
  }
  const value = authorization.slice(prefix.length);
  if (!CREDENTIAL_PATTERN.test(value)) {
    throw new CollabError({
      code: 'authentication-failed',
      safeContext: { reason: 'authorization-credential-invalid' },
    });
  }
  return value;
}
