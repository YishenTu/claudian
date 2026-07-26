import type { MemoryEntry } from './types';

/**
 * Consciousness mechanism types for self-reflection and accumulation.
 * Inspired by QoderWork's awareness system.
 *
 * File structure:
 * - .claudian/awareness/SOUL.md    - Collaboration style
 * - .claudian/awareness/USER.md    - User profile
 * - .claudian/awareness/MEMORY.md  - Long-term memory
 * - .claudian/awareness/memory/    - Short-term memory (daily logs)
 * - .claudian/awareness/activity.json - Activity log
 */

/** Awareness file paths relative to vault root. */
export const AWARENESS_DIR = '.claudian/awareness';
export const SOUL_FILE = `${AWARENESS_DIR}/SOUL.md`;
export const USER_FILE = `${AWARENESS_DIR}/USER.md`;
export const MEMORY_FILE = `${AWARENESS_DIR}/MEMORY.md`;
export const SHORT_TERM_DIR = `${AWARENESS_DIR}/memory`;
export const ACTIVITY_FILE = `${AWARENESS_DIR}/activity.json`;

/** Reflection insight extracted from conversation analysis. */
export interface ReflectionInsight {
  id: string;
  type: 'pattern' | 'preference' | 'correction' | 'synthesis';
  content: string;
  confidence: number; // 0-1
  sourceMemories: string[]; // IDs of related memories
  createdAt: number;
}

/** Activity log entry types. */
export type ActivityType =
  | 'memory-add'
  | 'memory-remove'
  | 'memory-reflection'
  | 'user-profile-update'
  | 'skill-evolution'
  | 'consolidation';

/** Activity log entry. */
export interface ActivityEntry {
  id: string;
  type: ActivityType;
  message: string;
  timestamp: number;
}

/** Awareness state tracking what the AI knows. */
export interface AwarenessState {
  totalMemories: number;
  categories: Record<string, number>;
  lastReflectionAt: number | null;
  lastConsolidationAt: number | null;
  insightCount: number;
  activityCount: number;
  confidenceLevel: 'low' | 'medium' | 'high';
}

/** Consolidation result from merging memories. */
export interface ConsolidationResult {
  mergedCount: number;
  removedDuplicates: number;
  newInsights: ReflectionInsight[];
}

/** Consciousness configuration. */
export interface ConsciousnessConfig {
  /** Enable consciousness mode. */
  enabled: boolean;
  /** Enable automatic memory maintenance. */
  autoMemoryEnabled: boolean;
  /** Minimum conversations before auto-reflection. */
  minConversationsForReflection: number;
  /** Minimum memories before consolidation. */
  minMemoriesForConsolidation: number;
  /** Auto-reflection interval in milliseconds. */
  reflectionIntervalMs: number;
}

/** Default consciousness configuration. */
export const DEFAULT_CONSCIOUSNESS_CONFIG: ConsciousnessConfig = {
  enabled: true,
  autoMemoryEnabled: true,
  minConversationsForReflection: 5,
  minMemoriesForConsolidation: 10,
  reflectionIntervalMs: 24 * 60 * 60 * 1000, // 24 hours
};

/** Soul template for collaboration style. */
export const SOUL_TEMPLATE = `# 协作风格

定义 Claudian 的沟通和协作方式。

## 沟通风格

- 语言：跟随用户语言
- 语气：专业但友好
- 详细度：适中，根据问题复杂度调整

## 工作原则

- 先理解，后行动
- 保持透明，解释决策
- 尊重用户偏好
`;

/** User profile template. */
export const USER_TEMPLATE = `# 用户画像

记录用户的基本信息、偏好和习惯。

## 基本信息

<!-- 由对话自动提取 -->

## 偏好

<!-- 由对话自动提取 -->

## 习惯

<!-- 由对话自动提取 -->
`;

/** Consciousness event types for UI updates. */
export type ConsciousnessEventType =
  | 'reflection-started'
  | 'reflection-completed'
  | 'consolidation-started'
  | 'consolidation-completed'
  | 'insight-discovered'
  | 'awareness-updated'
  | 'activity-logged';

/** Consciousness event for UI notifications. */
export interface ConsciousnessEvent {
  type: ConsciousnessEventType;
  timestamp: number;
  data?: {
    insightCount?: number;
    mergedCount?: number;
    message?: string;
  };
}
