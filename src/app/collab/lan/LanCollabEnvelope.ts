import { COLLAB_CONTROL_PROTOCOL_VERSION } from '@/app/collab/lan/LanCollabConstants';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface LanCollabEnvelope<T> {
  readonly data: T;
  readonly protocolVersion: typeof COLLAB_CONTROL_PROTOCOL_VERSION;
  readonly requestId: string;
}

function invalidEnvelope(): CollabError {
  return new CollabError({
    code: 'protocol-payload-invalid',
    safeContext: { field: 'envelope' },
  });
}

export function decodeLanCollabEnvelopeData(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidEnvelope();
  }
  const envelope = input as Readonly<Record<string, unknown>>;
  if (
    Object.keys(envelope).length !== 3
    || !Object.hasOwn(envelope, 'data')
    || envelope.protocolVersion !== COLLAB_CONTROL_PROTOCOL_VERSION
    || typeof envelope.requestId !== 'string'
    || envelope.requestId.length === 0
  ) {
    throw invalidEnvelope();
  }
  return envelope.data;
}
