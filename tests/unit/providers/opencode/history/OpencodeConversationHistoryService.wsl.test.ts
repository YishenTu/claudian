import { getInstallationKey } from '@/core/device/InstallationKey';
import { runProcessProbe } from '@/core/process/ProcessProbe';
import type { ProviderHistoryInput, ProviderHistoryPathContext } from '@/core/providers/types';
import { OpencodeConversationHistoryService } from '@/providers/opencode/history/OpencodeConversationHistoryService';

vi.mock('@/core/process/ProcessProbe', () => ({ runProcessProbe: vi.fn(async () => null) }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

function context(): ProviderHistoryPathContext {
  vi.stubGlobal('process', { ...process, platform: 'win32' });
  const key = getInstallationKey();
  return { vaultPath: 'C:\\Vault', environmentText: '', environment: {}, config: {
    installationMethodsByHost: { [key]: 'wsl' }, wslDistroOverridesByHost: { [key]: 'Unavailable' },
  } };
}

it('hydrates a draft without probing or initializing WSL when no native history exists', async () => {
  const pathContext = context();
  const input: ProviderHistoryInput = { sessionId: null, messages: [], providerState: {} };
  const initialize = vi.fn(async () => undefined);
  const service = new OpencodeConversationHistoryService({ getServerService: initialize });
  await expect(service.hydrateConversationHistory(input, 'C:\\Vault', pathContext)).resolves.toEqual(input);
  expect(initialize).not.toHaveBeenCalled();
  expect(runProcessProbe).not.toHaveBeenCalled();
});

it('keeps model recovery best-effort when the WSL environment cannot be read', async () => {
  const pathContext = context();
  const input: ProviderHistoryInput = { sessionId: 'native', messages: [], providerState: { databasePath: '\\\\wsl$\\Unavailable\\home\\alice\\.local\\share\\opencode\\opencode.db' } };
  await expect(new OpencodeConversationHistoryService().recoverConversationModelSelection(input, 'C:\\Vault', pathContext)).resolves.toBeNull();
  expect(input.providerState?.databasePath).toBe('\\\\wsl$\\Unavailable\\home\\alice\\.local\\share\\opencode\\opencode.db');
});
