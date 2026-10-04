import type { CodexAppServerRuntime } from '@/providers/codex/runtime/CodexAppServerRuntime';
import type { SkillMetadata } from '@/providers/codex/runtime/codexAppServerTypes';
import { CodexSkillListingService } from '@/providers/codex/skills/CodexSkillListingService';

const mockTransportRequest = jest.fn();
const mockResolveLaunchSpec = jest.fn();
const release = jest.fn().mockResolvedValue(undefined);
function createRuntime(): CodexAppServerRuntime {
  return {
    onSkillsChanged: () => () => undefined,
    acquire: async () => ({
      connection: { launchSpec: mockResolveLaunchSpec(), transport: { request: mockTransportRequest }, refreshPlugins: async () => undefined },
      release,
    }),
  } as unknown as CodexAppServerRuntime;
}

function makeSkill(name: string): SkillMetadata {
  return {
    name,
    description: `${name} description`,
    path: `/tmp/${name}/SKILL.md`,
    scope: 'repo',
    enabled: true,
  };
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20 && !condition(); attempt += 1) {
    await Promise.resolve();
  }
  expect(condition()).toBe(true);
}

describe('CodexSkillListingService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function createService() {
    const service = new CodexSkillListingService(createRuntime());
    const fetchSkills = jest.fn<Promise<SkillMetadata[]>, [boolean, AbortSignal?]>();
    jest.spyOn(service as any, 'fetchSkills').mockImplementation(fetchSkills as (...args: unknown[]) => Promise<SkillMetadata[]>);
    return { service, fetchSkills };
  }

  it('fetches again after a previous listing completes', async () => {
    const { service, fetchSkills } = createService();
    fetchSkills.mockResolvedValueOnce([makeSkill('alpha')]).mockResolvedValueOnce([makeSkill('beta')]);
    await expect(service.listSkills()).resolves.toEqual([makeSkill('alpha')]);
    await expect(service.listSkills()).resolves.toEqual([makeSkill('beta')]);
    expect(fetchSkills).toHaveBeenCalledTimes(2);
  });

  it('does not join a listing from before invalidation', async () => {
    const { service, fetchSkills } = createService();
    let resolveStale!: (skills: SkillMetadata[]) => void;
    fetchSkills
      .mockImplementationOnce(() => new Promise(resolve => { resolveStale = resolve; }))
      .mockResolvedValueOnce([makeSkill('fresh')]);
    const stale = service.listSkills();
    service.invalidate();
    await expect(service.listSkills()).resolves.toEqual([makeSkill('fresh')]);
    resolveStale([makeSkill('stale')]);
    await expect(stale).resolves.toEqual([makeSkill('stale')]);
    expect(fetchSkills).toHaveBeenCalledTimes(2);
  });

  it.each(['success', 'failure'])('aborts and awaits held listings that settle with %s during environment changes', async outcome => {
    const { service, fetchSkills } = createService();
    const staleSkills = [makeSkill('stale')];
    let resolveStale!: (skills: SkillMetadata[]) => void;
    let rejectStale!: (error: Error) => void;
    let ownedSignal: AbortSignal | undefined;
    fetchSkills
      .mockImplementationOnce((_forceReload, signal) => {
        ownedSignal = signal;
        return new Promise((resolve, reject) => { resolveStale = resolve; rejectStale = reject; });
      })
      .mockResolvedValueOnce([makeSkill('fresh')]);
    const staleListing = service.listSkills();
    const staleOutcome = staleListing.catch((error: unknown) => error);
    await waitForCondition(() => ownedSignal !== undefined);

    const quiesce = service.quiesceForEnvironmentChange();
    let quiesceSettled = false;
    void quiesce.then(() => { quiesceSettled = true; });
    await Promise.resolve();

    expect(ownedSignal).toBeDefined();
    expect(ownedSignal!.aborted).toBe(true);
    expect(quiesceSettled).toBe(false);

    if (outcome === 'failure') {
      rejectStale(new Error('Listing aborted'));
    } else {
      resolveStale(staleSkills);
    }
    await expect(staleOutcome).resolves.toEqual(outcome === 'failure' ? new Error('Listing aborted') : staleSkills);
    await quiesce;

    await expect(service.listSkills()).resolves.toEqual([makeSkill('fresh')]);
    expect(fetchSkills).toHaveBeenCalledTimes(2);
  });

  it('blocks skill listing during an environment transition and reloads from the new state', async () => {
    const { service, fetchSkills } = createService();
    let environment = 'old';
    fetchSkills.mockImplementation(async () => [makeSkill(environment)]);
    await expect(service.listSkills()).resolves.toEqual([makeSkill('old')]);

    service.beginEnvironmentTransition();
    await service.quiesceForEnvironmentChange();
    const listing = service.listSkills();
    try {
      await Promise.resolve();
      expect(fetchSkills).toHaveBeenCalledTimes(1);

      environment = 'new';
      service.endEnvironmentTransition();
      await expect(listing).resolves.toEqual([makeSkill('new')]);
    } finally {
      service.endEnvironmentTransition();
      await Promise.allSettled([listing]);
      await service.dispose();
    }
    expect(fetchSkills).toHaveBeenCalledTimes(2);
  });

  it('releases transition-blocked skill requests without starting a probe on disposal', async () => {
    const { service, fetchSkills } = createService();
    service.beginEnvironmentTransition();

    const listing = service.listSkills();
    await service.dispose();

    await expect(listing).resolves.toEqual([]);
    expect(fetchSkills).not.toHaveBeenCalled();
  });

  it('keeps the forced request available for coalescing when an older request finishes', async () => {
    const { service, fetchSkills } = createService();
    let resolveStale!: (skills: SkillMetadata[]) => void;
    let resolveFresh!: (skills: SkillMetadata[]) => void;
    fetchSkills
      .mockImplementationOnce(() => new Promise(resolve => { resolveStale = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveFresh = resolve; }));
    const stale = service.listSkills();
    const fresh = service.listSkills({ forceReload: true });
    resolveStale([makeSkill('stale')]);
    await stale;
    const joined = service.listSkills();
    expect(fetchSkills).toHaveBeenCalledTimes(2);
    resolveFresh([makeSkill('fresh')]);
    await expect(fresh).resolves.toEqual([makeSkill('fresh')]);
    await expect(joined).resolves.toEqual([makeSkill('fresh')]);
  });

  it('coalesces a normal request behind an in-flight forced refresh', async () => {
    const { service, fetchSkills } = createService();
    let resolveForced!: (skills: SkillMetadata[]) => void;
    fetchSkills.mockImplementationOnce(() => new Promise(resolve => {
      resolveForced = resolve;
    }));

    const forcedRequest = service.listSkills({ forceReload: true });
    const normalRequest = service.listSkills();

    expect(fetchSkills).toHaveBeenCalledTimes(1);
    expect(fetchSkills).toHaveBeenCalledWith(true, expect.any(AbortSignal));

    resolveForced([makeSkill('fresh')]);
    await expect(forcedRequest).resolves.toEqual([makeSkill('fresh')]);
    await expect(normalRequest).resolves.toEqual([makeSkill('fresh')]);
    expect(fetchSkills).toHaveBeenCalledTimes(1);
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

    const service = new CodexSkillListingService(createRuntime());

    const skills = await service.listSkills({ forceReload: true });

    expect(skills).toEqual([{
      ...makeSkill('review'),
      path: 'C:\\repo\\.codex\\skills\\review\\SKILL.md',
    }]);
    expect(mockTransportRequest).toHaveBeenCalledWith('skills/list', {
      cwds: ['/mnt/c/repo'],
      forceReload: true,
    }, undefined, expect.any(AbortSignal));
    expect(release).toHaveBeenCalledTimes(1);
  });

  // Shared startup, caller cancellation, and process lifetime are exercised together
  // in integration/providers/codex/runtime/CodexSharedRuntime.test.ts.
});
