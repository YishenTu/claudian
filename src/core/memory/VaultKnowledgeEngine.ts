import type { App, TFile } from 'obsidian';
import type { VaultFileAdapter } from '../storage/VaultFileAdapter';

/**
 * Knowledge extracted from a single vault note.
 */
export interface NoteKnowledge {
  path: string;
  title: string;
  tags: string[];
  headings: string[];
  frontmatter: Record<string, unknown>;
  wordCount: number;
  lastModified: number;
  excerpt: string; // First ~200 chars of content
}

/**
 * Vault knowledge index containing all extracted note knowledge.
 */
export interface VaultKnowledgeIndex {
  version: number;
  lastScanAt: number;
  noteCount: number;
  totalWords: number;
  notes: NoteKnowledge[];
  tagCloud: Record<string, number>;
  folderStructure: string[];
}

/**
 * Configuration for vault knowledge scanning.
 */
export interface VaultKnowledgeConfig {
  /** Enable vault knowledge indexing. */
  enabled: boolean;
  /** Maximum notes to index (0 = unlimited). */
  maxNotes: number;
  /** Folders to exclude from scanning. */
  excludeFolders: string[];
  /** File patterns to exclude. */
  excludePatterns: string[];
  /** Auto-scan interval in milliseconds (0 = disabled). */
  autoScanIntervalMs: number;
}

/** Default vault knowledge configuration. */
export const DEFAULT_VAULT_KNOWLEDGE_CONFIG: VaultKnowledgeConfig = {
  enabled: true,
  maxNotes: 500,
  excludeFolders: ['.obsidian', '.trash', '.claudian', 'node_modules', 'templates'],
  excludePatterns: ['*.canvas', '*.excalidraw'],
  autoScanIntervalMs: 0, // Manual scan by default
};

const KNOWLEDGE_FILE = '.claudian/awareness/vault-knowledge.json';

/**
 * VaultKnowledgeEngine scans and indexes all notes in the vault,
 * extracting key knowledge for consciousness injection.
 */
export class VaultKnowledgeEngine {
  private config: VaultKnowledgeConfig;
  private index: VaultKnowledgeIndex | null = null;

  constructor(
    private app: App,
    private adapter: VaultFileAdapter,
    config?: Partial<VaultKnowledgeConfig>,
  ) {
    this.config = { ...DEFAULT_VAULT_KNOWLEDGE_CONFIG, ...config };
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Update configuration at runtime. */
  updateConfig(config: Partial<VaultKnowledgeConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** Load existing knowledge index from disk. */
  async loadIndex(): Promise<VaultKnowledgeIndex | null> {
    if (this.index) {
      return this.index;
    }

    if (!(await this.adapter.exists(KNOWLEDGE_FILE))) {
      return null;
    }

    try {
      const content = await this.adapter.read(KNOWLEDGE_FILE);
      this.index = JSON.parse(content) as VaultKnowledgeIndex;
      return this.index;
    } catch {
      return null;
    }
  }

  /** Scan the vault and build knowledge index. */
  async scanVault(onProgress?: (current: number, total: number) => void): Promise<VaultKnowledgeIndex> {
    const files = this.app.vault.getMarkdownFiles();
    const filteredFiles = this.filterFiles(files);
    const total = Math.min(filteredFiles.length, this.config.maxNotes || filteredFiles.length);

    const notes: NoteKnowledge[] = [];
    const tagCloud: Record<string, number> = {};
    const folders = new Set<string>();

    for (let i = 0; i < total; i++) {
      const file = filteredFiles[i];
      onProgress?.(i + 1, total);

      try {
        const knowledge = await this.extractNoteKnowledge(file);
        notes.push(knowledge);

        // Aggregate tags
        for (const tag of knowledge.tags) {
          tagCloud[tag] = (tagCloud[tag] || 0) + 1;
        }

        // Track folder structure
        const folder = file.path.split('/').slice(0, -1).join('/');
        if (folder) {
          folders.add(folder);
        }
      } catch {
        // Skip files that can't be read
      }
    }

    const index: VaultKnowledgeIndex = {
      version: 1,
      lastScanAt: Date.now(),
      noteCount: notes.length,
      totalWords: notes.reduce((sum, n) => sum + n.wordCount, 0),
      notes,
      tagCloud,
      folderStructure: Array.from(folders).sort(),
    };

    // Save to disk
    await this.adapter.write(KNOWLEDGE_FILE, JSON.stringify(index, null, 2));
    this.index = index;

    return index;
  }

  /** Get a summary of vault knowledge for consciousness injection. */
  async getKnowledgeSummary(): Promise<string | null> {
    const index = await this.loadIndex();
    if (!index || index.noteCount === 0) {
      return null;
    }

    const topTags = Object.entries(index.tagCloud)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag, count]) => `${tag}(${count})`)
      .join(', ');

    const topFolders = index.folderStructure.slice(0, 10).join(', ');

    return [
      `### 仓库知识概览`,
      `- 笔记总数: ${index.noteCount}`,
      `- 总字数: ${index.totalWords.toLocaleString()}`,
      topTags ? `- 常用标签: ${topTags}` : '',
      topFolders ? `- 主要文件夹: ${topFolders}` : '',
      `- 最后扫描: ${new Date(index.lastScanAt).toLocaleString()}`,
    ].filter(Boolean).join('\n');
  }

  /** Search knowledge by query (simple keyword matching). */
  async searchKnowledge(query: string, limit = 5): Promise<NoteKnowledge[]> {
    const index = await this.loadIndex();
    if (!index) {
      return [];
    }

    const queryLower = query.toLowerCase();
    const scored = index.notes.map(note => {
      let score = 0;

      // Title match (highest weight)
      if (note.title.toLowerCase().includes(queryLower)) {
        score += 10;
      }

      // Tag match
      if (note.tags.some(tag => tag.toLowerCase().includes(queryLower))) {
        score += 5;
      }

      // Heading match
      if (note.headings.some(h => h.toLowerCase().includes(queryLower))) {
        score += 3;
      }

      // Excerpt match
      if (note.excerpt.toLowerCase().includes(queryLower)) {
        score += 1;
      }

      return { note, score };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.note);
  }

  /** Clear the knowledge index. */
  async clearIndex(): Promise<void> {
    await this.adapter.delete(KNOWLEDGE_FILE);
    this.index = null;
  }

  private filterFiles(files: TFile[]): TFile[] {
    return files.filter(file => {
      // Check excluded folders
      const pathParts = file.path.split('/');
      for (const folder of this.config.excludeFolders) {
        if (pathParts.includes(folder)) {
          return false;
        }
      }

      // Check excluded patterns
      for (const pattern of this.config.excludePatterns) {
        if (this.matchPattern(file.path, pattern)) {
          return false;
        }
      }

      return true;
    });
  }

  private matchPattern(path: string, pattern: string): boolean {
    // Simple glob matching for *.ext patterns
    if (pattern.startsWith('*.')) {
      return path.endsWith(pattern.slice(1));
    }
    return path.includes(pattern);
  }

  private async extractNoteKnowledge(file: TFile): Promise<NoteKnowledge> {
    const content = await this.app.vault.read(file);
    const cache = this.app.metadataCache.getFileCache(file);

    // Extract title from filename or first heading
    const title = file.basename;

    // Extract tags from frontmatter and inline
    const tags: string[] = [];
    if (cache?.frontmatter?.tags) {
      const fmTags = cache.frontmatter.tags;
      if (Array.isArray(fmTags)) {
        tags.push(...fmTags);
      } else if (typeof fmTags === 'string') {
        tags.push(...fmTags.split(',').map(t => t.trim()));
      }
    }
    if (cache?.tags) {
      tags.push(...cache.tags.map(t => t.tag.replace(/^#/, '')));
    }

    // Extract headings
    const headings = cache?.headings?.map(h => h.heading) || [];

    // Extract frontmatter (without tags to avoid duplication)
    const frontmatter: Record<string, unknown> = {};
    if (cache?.frontmatter) {
      for (const [key, value] of Object.entries(cache.frontmatter)) {
        if (key !== 'tags' && key !== 'position') {
          frontmatter[key] = value;
        }
      }
    }

    // Calculate word count (rough estimate)
    const wordCount = content.split(/\s+/).filter(w => w.length > 0).length;

    // Extract excerpt (first ~200 chars, excluding frontmatter)
    let excerpt = content;
    const fmEnd = content.indexOf('---', 3);
    if (content.startsWith('---') && fmEnd > 0) {
      excerpt = content.slice(fmEnd + 3).trim();
    }
    excerpt = excerpt.slice(0, 200).replace(/\n+/g, ' ').trim();

    return {
      path: file.path,
      title,
      tags: [...new Set(tags)], // Deduplicate
      headings,
      frontmatter,
      wordCount,
      lastModified: file.stat.mtime,
      excerpt,
    };
  }
}
