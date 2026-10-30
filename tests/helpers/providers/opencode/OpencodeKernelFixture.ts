import { OpencodeHTTPClient } from '@/providers/opencode/http/OpencodeHTTPClient';
import { OpencodeServerConfig } from '@/providers/opencode/http/OpencodeServerConfig';
import { OpencodeServerLease, OpencodeServerService } from '@/providers/opencode/http/OpencodeServerService';

/** Concrete instances for focused kernel fixtures; native HTTP/SSE coverage lives in integration suites. */
export function createOpencodeKernelLease(databasePath: string | null = null) {
  const unused = (): never => { throw new Error('Unexpected kernel fixture capability'); };
  const lease = new OpencodeServerLease({
    client: new OpencodeHTTPClient('/unused/opencode', '/workspace', {}),
    config: new OpencodeServerConfig('/unused/opencode/config.json', '/workspace', {}),
    databasePath, subscribers: new Set(), forms: new Map(),
  }, async () => {}, unused, () => () => {}, unused);
  vi.spyOn(lease, 'subscribe').mockImplementation(async () => {});
  vi.spyOn(lease, 'registerAgents').mockResolvedValue({});
  vi.spyOn(lease, 'waitForActivation').mockResolvedValue(undefined);
  vi.spyOn(lease, 'refreshGlobalForms').mockResolvedValue(undefined);
  vi.spyOn(lease, 'request').mockImplementation(unused);
  vi.spyOn(lease, 'dispose');
  const service = new OpencodeServerService();
  const acquire = vi.spyOn(service, 'acquire').mockResolvedValue(lease);
  return { lease, service, acquire };
}
