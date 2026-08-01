import type { FetchLike, Transport } from '@modelcontextprotocol/client';
import * as McpClientModule from '@modelcontextprotocol/client';

interface LegacySseTransportOptions {
  fetch: FetchLike;
  requestInit?: RequestInit;
}

type LegacySseTransportConstructor = new (
  url: URL,
  options?: LegacySseTransportOptions,
) => Transport;

export function createLegacySseTransport(
  url: URL,
  options: LegacySseTransportOptions,
): Transport {
  // The SDK retains this export for explicitly configured legacy SSE servers.
  // Resolve it behind a compatibility seam so its eventual removal becomes a
  // descriptive runtime error while modern HTTP stays on the typed API.
  const legacyConstructor = (
    McpClientModule as unknown as Record<string, unknown>
  )['SSEClientTransport'];
  if (typeof legacyConstructor !== 'function') {
    throw new Error('The MCP client does not support legacy SSE transports');
  }
  return new (legacyConstructor as LegacySseTransportConstructor)(url, options);
}
