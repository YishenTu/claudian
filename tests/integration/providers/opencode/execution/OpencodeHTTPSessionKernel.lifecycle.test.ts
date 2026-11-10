import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { createOpencodeKernelLease } from '@test/helpers/providers/opencode/OpencodeKernelFixture';

import type { ProviderSessionConfig } from '@/core/execution';
import { OpencodeHTTPSessionKernel } from '@/providers/opencode/execution/OpencodeHTTPSessionKernel';
import { OpencodeSessionPersistence } from '@/providers/opencode/execution/OpencodeSessionPersistence';

async function createKernel() {
  let release!: () => void;
  const admitted = new Promise<void>(resolve => { release = resolve; });
  const { host } = await createProviderHostFixture({ overrides: { getResolvedProviderCliPath: async () => '/bin/opencode' } });
  const { lease, service, acquire } = createOpencodeKernelLease('/db/opencode.db');
  vi.mocked(lease.request).mockImplementation(async (route: string) => route === '/api/model' ? { data: [{ id: 'model', providerID: 'test', enabled: true }] } : { data: {} });
  acquire.mockImplementation(async () => { await admitted; return lease; });
  const config: ProviderSessionConfig = { workingDirectory: '/workspace', lifecycle: 'persistent', nativePersistence: 'provider-default', interactionPort: { dismissInteraction: vi.fn(), requestApproval: vi.fn(() => { throw new Error('Unexpected approval'); }), askUserQuestion: vi.fn(() => { throw new Error('Unexpected question'); }) } };
  const kernel = new OpencodeHTTPSessionKernel({
    config, databasePath: '/db/opencode.db', getActiveTurnId: () => null, onClosed: vi.fn(),
    host: host.getRuntimeHost('opencode'), sessionInstanceId: 'kernel',
  }, service, new OpencodeSessionPersistence(config));
  return { kernel, lease, acquire, release };
}

const connectOptions = { profile: 'managed', systemPrompt: '' } as const;
const prompt = { text: 'hello', files: [], userText: null };

it('shares one connection attempt', async () => {
  const { kernel, acquire, release } = await createKernel();
  const first = kernel.connect(connectOptions);
  expect(kernel.connect(connectOptions)).toBe(first);
  release();
  await first;
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(acquire.mock.calls[0]?.[0]).toBe('/bin/opencode');
  await kernel.dispose();
});

it('settles calls before connection without native work', async () => {
  const { kernel, lease } = await createKernel();
  await expect(kernel.steer('ses', prompt)).resolves.toBe(false);
  expect(() => kernel.cancel('ses')).not.toThrow();
  await expect(kernel.openSession()).rejects.toThrow('OpenCode session is not connected');
  await expect(kernel.prompt('ses', prompt)).rejects.toThrow('OpenCode session is not connected');
  expect(() => kernel.setAutoApprove(true)).toThrow('OpenCode session is not connected');
  expect(lease.request).not.toHaveBeenCalled();
});

it('releases a lease admitted after disposal before disposal resolves', async () => {
  const { kernel, lease, release } = await createKernel();
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
