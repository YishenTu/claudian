import { createHash } from 'node:crypto';

export type AuthorityTransferChildOperation =
  | 'accept'
  | 'activate'
  | 'begin'
  | 'cancel'
  | 'claims'
  | 'custody'
  | 'relinquish'
  | 'source-ack'
  | 'stage';

export function authorityTransferChildIdempotencyKey(
  operationIntentId: string,
  operation: AuthorityTransferChildOperation,
): string {
  const digest = createHash('sha256')
    .update(`${operation}\0${operationIntentId}`, 'utf8')
    .digest('hex');
  return `authority-transfer-${operation}-${digest}`;
}
