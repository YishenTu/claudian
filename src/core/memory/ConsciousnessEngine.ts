import type { VaultFileAdapter } from '../storage/VaultFileAdapter';
import type { MemoryEntry } from './types';
import {
  ACTIVITY_FILE,
  type ActivityEntry,
  type ActivityType,
  AWARENESS_DIR,
  type AwarenessState,
  type ConsciousnessConfig,
  DEFAULT_CONSCIOUSNESS_CONFIG,
  MEMORY_FILE,
  SHORT_TERM_DIR,
  SOUL_FILE,
  SOUL_TEMPLATE,
  USER_FILE,
  USER_TEMPLATE,
} from './consciousness-types';

/**
 * ConsciousnessEngine manages the awareness system for self-reflection
 * and memory accumulation, inspired by QoderWork's consciousness mechanism.
 */
export class ConsciousnessEngine {
  private config: ConsciousnessConfig;

  constructor(
    private adapter: VaultFileAdapter,
    config?: Partial<ConsciousnessConfig>,
  ) {
    this.config = { ...DEFAULT_CONSCIOUSNESS_CONFIG, ...config };
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  get autoMemoryEnabled(): boolean {
    return this.config.autoMemoryEnabled;
  }

  /** Update configuration at runtime. */
  updateConfig(config: Partial<ConsciousnessConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** Initialize awareness directory and files if they don't exist. */
  async initialize(): Promise<void> {
    if (!this.config.enabled) return;

    await this.adapter.ensureFolder(AWARENESS_DIR);
    await this.adapter.ensureFolder(SHORT_TERM_DIR);

    // Create SOUL.md if not exists
    if (!(await this.adapter.exists(SOUL_FILE))) {
      await this.adapter.write(SOUL_FILE, SOUL_TEMPLATE);
    }

    // Create USER.md if not exists
    if (!(await this.adapter.exists(USER_FILE))) {
      await this.adapter.write(USER_FILE, USER_TEMPLATE);
    }

    // Create activity.json if not exists
    if (!(await this.adapter.exists(ACTIVITY_FILE))) {
      await this.adapter.write(ACTIVITY_FILE, '[]');
    }
  }

  /** Log an activity entry. */
  async logActivity(type: ActivityType, message: string): Promise<void> {
    if (!this.config.enabled) return;

    const activities = await this.loadActivities();
    const entry: ActivityEntry = {
      id: `act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type,
      message,
      timestamp: Date.now(),
    };

    // Keep only last 100 activities
    activities.unshift(entry);
    if (activities.length > 100) {
      activities.length = 100;
    }

    await this.adapter.write(ACTIVITY_FILE, JSON.stringify(activities, null, 2));
  }

  /** Load activity log. */
  async loadActivities(): Promise<ActivityEntry[]> {
    if (!(await this.adapter.exists(ACTIVITY_FILE))) {
      return [];
    }
    try {
      const content = await this.adapter.read(ACTIVITY_FILE);
      return JSON.parse(content) as ActivityEntry[];
    } catch {
      return [];
    }
  }

  /** Save short-term memory for today. */
  async saveShortTermMemory(content: string): Promise<void> {
    if (!this.config.enabled) return;

    const today = new Date().toISOString().split('T')[0];
    const filePath = `${SHORT_TERM_DIR}/${today}.md`;

    const existing = await this.adapter.exists(filePath)
      ? await this.adapter.read(filePath)
      : `# ${today}\n\n`;

    const timestamp = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const newContent = `${existing}\n## ${timestamp}\n\n${content}\n`;

    await this.adapter.write(filePath, newContent);
  }

  /** Get awareness state summary. */
  async getAwarenessState(memories: MemoryEntry[]): Promise<AwarenessState> {
    const activities = await this.loadActivities();
    const categories: Record<string, number> = {};

    for (const mem of memories) {
      categories[mem.category] = (categories[mem.category] || 0) + 1;
    }

    const reflectionActivities = activities.filter(a => a.type === 'memory-reflection');
    const lastReflection = reflectionActivities.length > 0
      ? reflectionActivities[0].timestamp
      : null;

    const consolidationActivities = activities.filter(a => a.type === 'consolidation');
    const lastConsolidation = consolidationActivities.length > 0
      ? consolidationActivities[0].timestamp
      : null;

    // Calculate confidence based on memory count and recency
    let confidenceLevel: 'low' | 'medium' | 'high' = 'low';
    if (memories.length >= 20) {
      confidenceLevel = 'high';
    } else if (memories.length >= 5) {
      confidenceLevel = 'medium';
    }

    return {
      totalMemories: memories.length,
      categories,
      lastReflectionAt: lastReflection,
      lastConsolidationAt: lastConsolidation,
      insightCount: reflectionActivities.length,
      activityCount: activities.length,
      confidenceLevel,
    };
  }

  /** Check if reflection should be triggered. */
  shouldReflect(memories: MemoryEntry[], conversationCount: number): boolean {
    if (!this.config.enabled || !this.config.autoMemoryEnabled) {
      return false;
    }

    if (conversationCount < this.config.minConversationsForReflection) {
      return false;
    }

    if (memories.length < this.config.minMemoriesForConsolidation) {
      return false;
    }

    return true;
  }

  /** Get soul content (collaboration style). */
  async getSoul(): Promise<string | null> {
    if (!(await this.adapter.exists(SOUL_FILE))) {
      return null;
    }
    return this.adapter.read(SOUL_FILE);
  }

  /** Get user profile content. */
  async getUserProfile(): Promise<string | null> {
    if (!(await this.adapter.exists(USER_FILE))) {
      return null;
    }
    return this.adapter.read(USER_FILE);
  }

  /** Update user profile with new information. */
  async updateUserProfile(section: string, content: string): Promise<void> {
    if (!this.config.enabled) return;

    const profile = await this.getUserProfile() || USER_TEMPLATE;
    const sectionHeader = `## ${section}`;

    if (profile.includes(sectionHeader)) {
      // Append to existing section
      const updated = profile.replace(
        new RegExp(`(${sectionHeader}\\n)`),
        `$1\n- ${content}\n`,
      );
      await this.adapter.write(USER_FILE, updated);
    }

    await this.logActivity('user-profile-update', `更新用户画像: ${section}`);
  }

  /** Build consciousness injection for system prompt. */
  async buildConsciousnessInjection(memories: MemoryEntry[]): Promise<string | null> {
    if (!this.config.enabled) {
      return null;
    }

    const parts: string[] = [];

    // Add soul/collaboration style summary
    const soul = await this.getSoul();
    if (soul) {
      const soulSummary = soul.split('\n').slice(0, 10).join('\n');
      parts.push(`### 协作风格\n${soulSummary}`);
    }

    // Add user profile summary
    const profile = await this.getUserProfile();
    if (profile) {
      const profileSummary = profile.split('\n').slice(0, 15).join('\n');
      parts.push(`### 用户画像\n${profileSummary}`);
    }

    if (parts.length === 0) {
      return null;
    }

    return `## 意识状态\n\n${parts.join('\n\n')}`;
  }

  /** Clear all awareness data (dangerous operation). */
  async clearAll(): Promise<void> {
    await this.adapter.delete(SOUL_FILE);
    await this.adapter.delete(USER_FILE);
    await this.adapter.delete(ACTIVITY_FILE);

    // Re-initialize with templates
    await this.initialize();
  }
}
