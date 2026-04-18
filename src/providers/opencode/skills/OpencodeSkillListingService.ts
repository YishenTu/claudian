import type { OpencodeSkillMetadata } from '../types';

export class OpencodeSkillListingService {
  private cachedSkills: OpencodeSkillMetadata[] = [];
  private cacheTime = 0;
  private readonly CACHE_TTL_MS = 5000;

  async listSkills(): Promise<OpencodeSkillMetadata[]> {
    return [];
  }

  invalidate(): void {
    this.cacheTime = 0;
  }
}
