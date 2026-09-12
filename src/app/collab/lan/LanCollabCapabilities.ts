import { CollabError } from '@/core/collab/ClaudianCollabError';

// Capabilities describe optional LAN bindings, not Member authorization.
export const LAN_COLLAB_CAPABILITIES = Object.freeze([
  'ticket-number-lookup-v1',
] as const);

export type LanCollabCapability = typeof LAN_COLLAB_CAPABILITIES[number];

export function decodeLanCollabCapabilities(value: unknown): readonly string[] {
  // Published base-only Hosts do not send capability metadata.
  if (value === undefined) return [];
  if (
    !Array.isArray(value)
    || value.length > 128
    || !value.every((token: unknown): token is string => typeof token === 'string'
      && token.length <= 128 && /^[a-z][a-z0-9-]*$/.test(token))
  ) {
    throw new CollabError({
      code: 'protocol-payload-invalid',
      safeContext: { field: 'capabilities' },
    });
  }
  return value;
}
