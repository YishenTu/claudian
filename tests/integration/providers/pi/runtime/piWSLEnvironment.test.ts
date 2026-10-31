import { WSLProcessFixture } from '@test/helpers/WSLProcessFixture';
import spawn from 'cross-spawn';

import { probeTargetEnvironment } from '@/core/process/execution-target/TargetEnvironmentProbe';
import { getPiWSLForwardedEnvironment } from '@/providers/pi/runtime/piWSLEnvironment';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

it('delivers the configured Windows CA file as a Linux path to Pi environment probes', async () => {
  const native = new WSLProcessFixture();
  vi.mocked(spawn).mockReset().mockImplementation(native.spawn);
  const env = { NODE_EXTRA_CA_CERTS: String.raw`C:\Certs\company.pem` };
  const result = await probeTargetEnvironment({
    target: { method: 'wsl', distroName: 'Ubuntu', platformOs: 'linux', platformFamily: 'unix' },
    hostCwd: 'C:\\Vault', env,
    forwardEnvironment: getPiWSLForwardedEnvironment(env, `NODE_EXTRA_CA_CERTS=${env.NODE_EXTRA_CA_CERTS}`),
    variables: ['NODE_EXTRA_CA_CERTS'],
  });
  expect(result).toEqual({ NODE_EXTRA_CA_CERTS: '/mnt/c/Certs/company.pem' });
});
