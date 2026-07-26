export { ConsciousnessEngine } from './ConsciousnessEngine';
export {
  ACTIVITY_FILE,
  type ActivityEntry,
  type ActivityType,
  AWARENESS_DIR,
  type AwarenessState,
  type ConsciousnessConfig,
  type ConsciousnessEvent,
  type ConsciousnessEventType,
  DEFAULT_CONSCIOUSNESS_CONFIG,
  MEMORY_FILE,
  type ReflectionInsight,
  SHORT_TERM_DIR,
  SOUL_FILE,
  SOUL_TEMPLATE,
  USER_FILE,
  USER_TEMPLATE,
} from './consciousness-types';
export { MemoryExtractor } from './MemoryExtractor';
export { formatMemoryAppendix, wrapMemoryInjection } from './memoryPrompt';
export { MemoryStore } from './MemoryStore';
export {
  DEFAULT_MEMORY_FILE_PATH,
  DEFAULT_MEMORY_MAX_INJECTION_CHARS,
  MEMORY_FILE_TEMPLATE,
  type MemoryEntry,
  type MemoryExtractionResult,
  type MemoryStoreOptions,
} from './types';
export {
  DEFAULT_VAULT_KNOWLEDGE_CONFIG,
  type NoteKnowledge,
  type VaultKnowledgeConfig,
  type VaultKnowledgeIndex,
  VaultKnowledgeEngine,
} from './VaultKnowledgeEngine';
