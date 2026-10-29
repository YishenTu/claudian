import { OpencodeHTTPSessionKernel } from '@/providers/opencode/execution/OpencodeHTTPSessionKernel';
import { OpencodeSessionPersistence } from '@/providers/opencode/execution/OpencodeSessionPersistence';

function createLease() {
  return {
    databasePath: '/db/opencode.db', isReusable: () => true, onRetired: () => {}, onSuperseded: () => {},
    subscribe: async () => {}, registerAgents: async () => ({}), waitForActivation: async () => {}, refreshGlobalForms: async () => {},
    dispose: vi.fn(async () => {}),
    request: vi.fn(async (route: string) => route === '/api/model' ? { data: [{ id: 'model', providerID: 'test', enabled: true }] } : { data: {} }),
  };
}

function createKernel() {
  let release!: () => void;
  const admitted = new Promise<void>(resolve => { release = resolve; });
  const lease = createLease();
  const acquire = vi.fn(async (_cliPath: string, _cwd: string, _environment: NodeJS.ProcessEnv) => { await admitted; return lease; });
  const config = { workingDirectory: '/workspace', lifecycle: 'persistent', nativePersistence: 'provider-default', interactionPort: { dismissInteraction: vi.fn() } } as any;
  const kernel = new OpencodeHTTPSessionKernel({
    config, databasePath: '/db/opencode.db', getActiveTurnId: () => null, onClosed: vi.fn(),
    host: { resolveCliPath: async () => '/bin/opencode', environmentText: '' },
  } as any, { acquire } as any, new OpencodeSessionPersistence(config));
  return { kernel, lease, acquire, release };
}

const connectOptions = { profile: 'managed', systemPrompt: '' } as const;
const prompt = { text: 'hello', files: [], userText: null };

it('shares one connection attempt', async () => {
  const { kernel, acquire, release } = createKernel();
  const first = kernel.connect(connectOptions);
  expect(kernel.connect(connectOptions)).toBe(first);
  release();
  await first;
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(acquire.mock.calls[0]?.[0]).toBe('/bin/opencode');
  await kernel.dispose();
});

it('settles calls before connection without native work', async () => {
  const { kernel, lease } = createKernel();
  await expect(kernel.steer('ses', prompt)).resolves.toBe(false);
  expect(() => kernel.cancel('ses')).not.toThrow();
  await expect(kernel.openSession()).rejects.toThrow('OpenCode session is not connected');
  await expect(kernel.prompt('ses', prompt)).rejects.toThrow('OpenCode session is not connected');
  expect(() => kernel.setAutoApprove(true)).toThrow('OpenCode session is not connected');
  expect(lease.request).not.toHaveBeenCalled();
});

it('releases a lease admitted after disposal before disposal resolves', async () => {
  const { kernel, lease, release } = createKernel();
  const connection = kernel.connect(connectOptions);
  void connection.catch(() => undefined);
  await Promise.resolve();
  let disposed = false;
  const disposal = kernel.dispose().then(() => { disposed = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(disposed).toBe(false);
  release();
  await disposal;
  expect(lease.dispose).toHaveBeenCalled();
  await expect(connection).rejects.toThrow();
  await expect(kernel.steer('ses', prompt)).resolves.toBe(false);
  await expect(kernel.connect(connectOptions)).rejects.toThrow('OpenCode session is disposed');
});
