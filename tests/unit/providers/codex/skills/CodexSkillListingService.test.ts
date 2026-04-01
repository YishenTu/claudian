import type { SkillMetadata } from '@/providers/codex/runtime/codexAppServerTypes';
import { CodexSkillListingService } from '@/providers/codex/skills/CodexSkillListingService';

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
  function createService(ttlMs = 5_000) {
    let currentTime = 1_000;
    const service = new CodexSkillListingService({} as any, {
      ttlMs,
      now: () => currentTime,
    });
    const fetchSkills = jest.fn<Promise<SkillMetadata[]>, [boolean]>();
    jest.spyOn(service as any, 'fetchSkills').mockImplementation(fetchSkills);

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
});
