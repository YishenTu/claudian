import type { MemoryEntry, MemoryExtractionResult } from './types';

/** Minimum content length for containment-based deduplication. */
const MIN_CONTAINMENT_LENGTH = 10;

/** Trigger phrases that indicate the user wants to save a memory. */
const TRIGGER_PATTERNS: RegExp[] = [
  /(?:请|你)?记住[：:，,\s]*(.+)/,
  /(?:请|你)?记得[：:，,\s]*(.+)/,
  /别忘了[：:，,\s]*(.+)/,
  /(?:请|你)?remember(?:\s+that)?[：:，,\s]*(.+)/i,
  /keep\s+in\s+mind[：:，,\s]*(.+)/i,
  /note\s+that[：:，,\s]*(.+)/i,
  /save\s+(?:this\s+)?(?:to\s+)?memory[：:，,\s]*(.+)/i,
  /(?:请|你)?记下[：:，,\s]*(.+)/,
  /(?:请|你)?记录[：:，,\s]*(.+)/,
];

/**
 * Implicit patterns that indicate important information worth remembering.
 * These don't require explicit "remember" commands.
 */
const IMPLICIT_PATTERNS: Array<{
  pattern: RegExp;
  category: string;
  extract: (match: RegExpMatchArray) => string;
}> = [
  // User preferences - Chinese
  { pattern: /我(?:比较|很|非常|特别)?喜欢(.{3,30})/, category: 'User Preferences', extract: m => `喜欢${m[1]}` },
  { pattern: /我(?:比较|很|非常|特别)?偏好(.{3,30})/, category: 'User Preferences', extract: m => `偏好${m[1]}` },
  { pattern: /我(?:通常|一般|平时|习惯)(.{3,30})/, category: 'Work Habits', extract: m => `习惯${m[1]}` },
  { pattern: /我不(?:喜欢|想要|希望)(.{3,30})/, category: 'User Preferences', extract: m => `不喜欢${m[1]}` },
  // User preferences - English
  { pattern: /I\s+(?:really\s+|very\s+)?(?:like|love|prefer|enjoy)\s+(.{3,40})/i, category: 'User Preferences', extract: m => `Prefers ${m[1]}` },
  { pattern: /I\s+(?:usually|normally|typically|always)\s+(.{3,40})/i, category: 'Work Habits', extract: m => `Usually ${m[1]}` },
  { pattern: /I\s+don't\s+(?:like|want|prefer)\s+(.{3,40})/i, category: 'User Preferences', extract: m => `Dislikes ${m[1]}` },
  // Personal info
  { pattern: /我叫(.{2,10})/, category: 'Personal', extract: m => `名字是${m[1]}` },
  { pattern: /我的名字是(.{2,10})/, category: 'Personal', extract: m => `名字是${m[1]}` },
  { pattern: /(?:my\s+name\s+is|i'm|i\s+am)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i, category: 'Personal', extract: m => `Name is ${m[1]}` },
  // Project context
  { pattern: /(?:我们|我的)?项目(?:用的是|使用|采用)(.{3,30})/, category: 'Project Context', extract: m => `项目使用${m[1]}` },
  { pattern: /(?:我们|我的)?技术栈(?:是|为)(.{3,30})/, category: 'Project Context', extract: m => `技术栈是${m[1]}` },
  { pattern: /(?:our|my|the)\s+project\s+(?:uses?|is\s+using)\s+(.{3,40})/i, category: 'Project Context', extract: m => `Project uses ${m[1]}` },
  // Corrections (important for learning)
  { pattern: /不对[，,]?应该(?:是|用)(.{3,30})/, category: 'Rules', extract: m => `纠正：应该是${m[1]}` },
  { pattern: /不是[，,]?(?:应该|而是)(.{3,30})/, category: 'Rules', extract: m => `纠正：${m[1]}` },
  { pattern: /(?:no|actually)[，,]?\s*(?:it\s+)?should\s+(?:be|use)\s+(.{3,40})/i, category: 'Rules', extract: m => `Correction: should be ${m[1]}` },
];

/** Trigger phrases that indicate the user wants to forget/remove a memory. */
const FORGET_PATTERNS: RegExp[] = [
  /(?:请|你)?忘记[：:，,\s]*(.+)/,
  /(?:请|你)?忘掉[：:，,\s]*(.+)/,
  /(?:请|你)?删除记忆[：:，,\s]*(.+)/,
  /(?:请|你)?移除记忆[：:，,\s]*(.+)/,
  /forget(?:\s+that)?[：:，,\s]*(.+)/i,
  /remove\s+(?:the\s+)?memory[：:，,\s]*(.+)/i,
  /delete\s+(?:the\s+)?memory[：:，,\s]*(.+)/i,
];

/** Trigger phrases that indicate the user wants to list/view memories. */
const LIST_PATTERNS: RegExp[] = [
  /(?:列出|显示|查看|展示)(?:所有)?记忆/,
  /(?:我(?:有|的)?(?:哪些|什么)?)?记忆(?:有哪些|有什么)?/,
  /list\s+(?:all\s+)?(?:my\s+)?memories/i,
  /show\s+(?:all\s+)?(?:my\s+)?memories/i,
  /what\s+(?:do\s+you\s+)?(?:know|remember)\s+about\s+me/i,
];

/** Patterns that indicate a category for the memory. */
const CATEGORY_PATTERNS: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /(?:偏好|preference|喜欢|prefer|最爱|favorite)/i, category: 'User Preferences' },
  { pattern: /(?:项目|project|技术栈|tech|框架|framework)/i, category: 'Project Context' },
  { pattern: /(?:习惯|habit|workflow|流程|工作方式)/i, category: 'Work Habits' },
  { pattern: /(?:规则|rule|always|never|总是|从不|必须|禁止)/i, category: 'Rules' },
  { pattern: /(?:语言|language|中文|英文|Chinese|English|日语|Japanese)/i, category: 'Language' },
  { pattern: /(?:工具|tool|编辑器|editor|IDE|插件|plugin)/i, category: 'Tools' },
  { pattern: /(?:环境|environment|配置|config|设置|setting)/i, category: 'Environment' },
  { pattern: /(?:名字|name|称呼|call me|我是)/i, category: 'Personal' },
];

/**
 * MemoryExtractor extracts memory entries from user messages.
 *
 * MVP: keyword-triggered extraction. Phase 2 can replace with LLM-based extraction.
 */
export class MemoryExtractor {
  /**
   * Extract memory entries from a user message.
   * Returns empty array if no trigger is detected.
   */
  extract(message: string, existingEntries: MemoryEntry[]): MemoryExtractionResult {
    const extracted = this.extractFromMessage(message);
    if (extracted.length === 0) {
      return { entries: [] };
    }

    // Deduplicate against existing entries
    const unique = extracted.filter(entry =>
      !this.isDuplicate(entry.content, existingEntries)
    );

    return { entries: unique };
  }

  /**
   * Extract a forget/remove request from a user message.
   * Returns the search term to remove, or null if no forget trigger is detected.
   */
  extractForgetRequest(message: string): string | null {
    for (const pattern of FORGET_PATTERNS) {
      const match = message.match(pattern);
      if (match && match[1]) {
        const searchTerm = match[1].trim();
        if (searchTerm.length >= 3) {
          return searchTerm;
        }
      }
    }
    return null;
  }

  /**
   * Check if the message is a request to list/view memories.
   */
  isListRequest(message: string): boolean {
    return LIST_PATTERNS.some(pattern => pattern.test(message));
  }

  /**
   * Placeholder for LLM-based extraction (Phase 2).
   */
  async extractWithModel(
    _message: string,
    _existingEntries: MemoryEntry[],
    _modelQuery: (prompt: string) => Promise<string>,
  ): Promise<MemoryExtractionResult> {
    // Phase 2: use model to extract implicit memories
    return { entries: [] };
  }

  /**
   * Extract implicit memories from a message without requiring trigger words.
   * This is the core of the "consciousness" mechanism - automatically identifying
   * important information worth remembering from natural conversation.
   */
  extractImplicit(message: string, existingEntries: MemoryEntry[]): MemoryExtractionResult {
    const extracted = this.extractImplicitFromMessage(message);
    if (extracted.length === 0) {
      return { entries: [] };
    }

    // Deduplicate against existing entries
    const unique = extracted.filter(entry =>
      !this.isDuplicate(entry.content, existingEntries)
    );

    return { entries: unique };
  }

  private extractImplicitFromMessage(message: string): MemoryEntry[] {
    const entries: MemoryEntry[] = [];
    const now = Date.now();

    for (const { pattern, category, extract } of IMPLICIT_PATTERNS) {
      const match = message.match(pattern);
      if (match) {
        const content = extract(match).trim();
        if (content.length >= 3) {
          entries.push({
            id: `mem_implicit_${now}_${entries.length}`,
            category,
            content,
            source: 'user-implicit',
            createdAt: now,
            updatedAt: now,
          });
        }
      }
    }

    return entries;
  }

  private extractFromMessage(message: string): MemoryEntry[] {
    const entries: MemoryEntry[] = [];
    const now = Date.now();

    for (const pattern of TRIGGER_PATTERNS) {
      const match = message.match(pattern);
      if (match && match[1]) {
        const content = match[1].trim();
        if (content.length < 3) continue;

        const category = this.inferCategory(content);
        entries.push({
          id: `mem_extract_${now}_${entries.length}`,
          category,
          content,
          source: 'user-explicit',
          createdAt: now,
          updatedAt: now,
        });
        // Only extract the first match per message to avoid duplicates
        break;
      }
    }

    return entries;
  }

  private inferCategory(content: string): string {
    for (const { pattern, category } of CATEGORY_PATTERNS) {
      if (pattern.test(content)) {
        return category;
      }
    }
    return 'User Preferences';
  }

  private isDuplicate(content: string, existing: MemoryEntry[]): boolean {
    const normalizedContent = content.toLowerCase().trim();
    return existing.some(entry => {
      const normalizedExisting = entry.content.toLowerCase().trim();
      // Exact match
      if (normalizedContent === normalizedExisting) return true;
      // Containment check only for sufficiently long strings to avoid false positives
      if (normalizedContent.length >= MIN_CONTAINMENT_LENGTH) {
        if (normalizedExisting.includes(normalizedContent)) return true;
      }
      if (normalizedExisting.length >= MIN_CONTAINMENT_LENGTH) {
        if (normalizedContent.includes(normalizedExisting)) return true;
      }
      return false;
    });
  }
}
