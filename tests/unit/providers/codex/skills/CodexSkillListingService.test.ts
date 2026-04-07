import type { SkillMetadata } from '@/providers/codex/runtime/codexAppServerTypes';
import { CodexSkillListingService } from '@/providers/codex/skills/CodexSkillListingService';

const mockTransportRequest = jest.fn();
const mockTransportDispose = jest.fn();
const mockTransportStart = jest.fn();
const mockProcessStart = jest.fn();
const mockProcessShutdown = jest.fn().mockResolvedValue(undefined);
const mockResolveLaunchSpec = jest.fn();

jest.mock('@/providers/codex/runtime/CodexRpcTransport', () => ({
  CodexRpcTransport: jest.fn().mockImplementation(() => ({
    request: mockTransportRequest,
    dispose: mockTransportDispose,
    start: mockTransportStart,
    notify: jest.fn(),
  })),
}));

jest.mock('@/providers/codex/runtime/CodexAppServerProcess', () => ({
  CodexAppServerProcess: jest.fn().mockImplementation(() => ({
    start: mockProcessStart,
    shutdown: mockProcessShutdown,
  })),
}));

jest.mock('@/providers/codex/runtime/codexAppServerSupport', () => ({
  initializeCodexAppServerTransport: jest.fn().mockResolvedValue({
    userAgent: 'test/0.1',
    codexHome: '/home/user/.codex',
    platformFamily: 'unix',
    platformOs: 'linux',
  }),
  resolveCodexAppServerLaunchSpec: (...args: unknown[]) => mockResolveLaunchSpec(...args),
}));

import { CodexAppServerProcess as MockedProcessClass } from '@/providers/codex/runtime/CodexAppServerProcess';

function makeSkill(name: string): SkillMetadata {
  return {
    name,
    description: `${name} description`,
    path: `/tmp/${name}/SKILL.md`,
    scope: 'repo',
    enabled: true,
  };
}

describe('CodexSkillListingService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function createService(ttlMs = 5_000) {
    let currentTime = 1_000;
    const service = new CodexSkillListingService({} as any, {
      ttlMs,
      now: () => currentTime,
    });
    const fetchSkills = jest.fn<Promise<SkillMetadata[]>, [boolean]>();
    jest.spyOn(service as any, 'fetchSkills').mockImplementation(fetchSkills as (...args: unknown[]) => Promise<SkillMetadata[]>);

    return {
      service,
      fetchSkills,
      setNow(value: number) {
        currentTime = value;
      },
    };
  }

  it('returns cached results until the TTL expires', async () => {
    const { service, fetchSkills, setNow } = createService(5_000);
    const alpha = [makeSkill('alpha')];
    const beta = [makeSkill('beta')];

    fetchSkills.mockResolvedValueOnce(alpha).mockResolvedValueOnce(beta);

    await expect(service.listSkills()).resolves.toEqual(alpha);
    await expect(service.listSkills()).resolves.toEqual(alpha);
    expect(fetchSkills).toHaveBeenCalledTimes(1);
    expect(fetchSkills).toHaveBeenNthCalledWith(1, false);

    setNow(5_999);
    await expect(service.listSkills()).resolves.toEqual(alpha);
    expect(fetchSkills).toHaveBeenCalledTimes(1);

    setNow(6_000);
    await expect(service.listSkills()).resolves.toEqual(beta);
    expect(fetchSkills).toHaveBeenCalledTimes(2);
    expect(fetchSkills).toHaveBeenNthCalledWith(2, false);
  });

  it('forceReload bypasses the cache and replaces it', async () => {
    const { service, fetchSkills } = createService(5_000);
    const alpha = [makeSkill('alpha')];
    const beta = [makeSkill('beta')];

    fetchSkills.mockResolvedValueOnce(alpha).mockResolvedValueOnce(beta);

    await expect(service.listSkills()).resolves.toEqual(alpha);
    await expect(service.listSkills({ forceReload: true })).resolves.toEqual(beta);
    await expect(service.listSkills()).resolves.toEqual(beta);

    expect(fetchSkills).toHaveBeenCalledTimes(2);
    expect(fetchSkills).toHaveBeenNthCalledWith(1, false);
    expect(fetchSkills).toHaveBeenNthCalledWith(2, true);
  });

  it('invalidate clears the cache before the TTL expires', async () => {
    const { service, fetchSkills } = createService(5_000);
    const alpha = [makeSkill('alpha')];
    const beta = [makeSkill('beta')];

    fetchSkills.mockResolvedValueOnce(alpha).mockResolvedValueOnce(beta);

    await expect(service.listSkills()).resolves.toEqual(alpha);
    service.invalidate();
    await expect(service.listSkills()).resolves.toEqual(beta);

    expect(fetchSkills).toHaveBeenCalledTimes(2);
    expect(fetchSkills).toHaveBeenNthCalledWith(1, false);
    expect(fetchSkills).toHaveBeenNthCalledWith(2, false);
  });

  it('uses the launch spec target cwd when fetching skills from Codex', async () => {
    mockResolveLaunchSpec.mockReturnValue({
      target: { method: 'wsl', platformFamily: 'unix', platformOs: 'linux', distroName: 'Ubuntu' },
      command: 'wsl.exe',
      args: ['--distribution', 'Ubuntu', '--cd', '/mnt/c/repo', 'codex', 'app-server', '--listen', 'stdio://'],
      spawnCwd: 'C:\\repo',
      targetCwd: '/mnt/c/repo',
      env: { OPENAI_API_KEY: 'sk-test' },
      pathMapper: {
        target: { method: 'wsl', platformFamily: 'unix', platformOs: 'linux', distroName: 'Ubuntu' },
        toTargetPath: jest.fn(),
        toHostPath: jest.fn((value: string) => value.replace('/mnt/c/repo', 'C:\\repo').replace(/\//g, '\\')),
        mapTargetPathList: jest.fn(),
        canRepresentHostPath: jest.fn(),
      },
    });
    mockTransportRequest.mockResolvedValue({
      data: [{
        cwd: '/mnt/c/repo',
        skills: [{
          ...makeSkill('review'),
          path: '/mnt/c/repo/.codex/skills/review/SKILL.md',
        }],
      }],
    });

    const service = new CodexSkillListingService({
      settings: {},
      getResolvedProviderCliPath: jest.fn(),
      getActiveEnvironmentVariables: jest.fn(),
      app: {
        vault: {
          adapter: { basePath: 'C:\\repo' },
        },
      },
    } as any, { ttlMs: 0 });

    const skills = await service.listSkills({ forceReload: true });

    expect(skills).toEqual([{
      ...makeSkill('review'),
      path: 'C:\\repo\\.codex\\skills\\review\\SKILL.md',
    }]);
    expect(MockedProcessClass).toHaveBeenCalledWith(expect.objectContaining({
      command: 'wsl.exe',
      targetCwd: '/mnt/c/repo',
    }));
    expect(mockTransportRequest).toHaveBeenCalledWith('skills/list', {
      cwds: ['/mnt/c/repo'],
      forceReload: true,
    });
  });
});
