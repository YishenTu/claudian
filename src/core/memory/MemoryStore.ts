import type { VaultFileAdapter } from '../storage/VaultFileAdapter';
import {
  DEFAULT_MEMORY_FILE_PATH,
  DEFAULT_MEMORY_MAX_INJECTION_CHARS,
  MEMORY_FILE_TEMPLATE,
  type MemoryEntry,
  type MemoryStoreOptions,
} from './types';

function generateMemoryId(): string {
  return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

interface ParsedSection {
  category: string;
  items: string[];
}

/**
 * MemoryStore reads/writes a Markdown memory file in the vault.
 *
 * File format:
 * - `## Category` headings define categories.
 * - `- item` list entries under a heading are individual memories.
 */
export class MemoryStore {
  private options: MemoryStoreOptions;

  constructor(
    private adapter: VaultFileAdapter,
    options?: Partial<MemoryStoreOptions>,
  ) {
    this.options = {
      filePath: options?.filePath || DEFAULT_MEMORY_FILE_PATH,
      maxInjectionChars: options?.maxInjectionChars ?? DEFAULT_MEMORY_MAX_INJECTION_CHARS,
    };
  }

  get filePath(): string {
    return this.options.filePath;
  }

  get maxInjectionChars(): number {
    return this.options.maxInjectionChars;
  }

  /** Update options at runtime (e.g. when settings change). */
  updateOptions(options: Partial<MemoryStoreOptions>): void {
    if (options.filePath !== undefined) {
      this.options.filePath = options.filePath;
    }
    if (options.maxInjectionChars !== undefined) {
      this.options.maxInjectionChars = options.maxInjectionChars;
    }
  }

  /** Load all memory entries from the file. Returns [] if file doesn't exist. */
  async load(): Promise<MemoryEntry[]> {
    if (!(await this.adapter.exists(this.options.filePath))) {
      return [];
    }

    const content = await this.adapter.read(this.options.filePath);
    return this.parseMarkdown(content);
  }

  /** Save entries back to the memory file, preserving the Markdown format. */
  async save(entries: MemoryEntry[]): Promise<void> {
    const content = this.serializeMarkdown(entries);
    await this.adapter.write(this.options.filePath, content);
  }

  /** Add a new memory entry. Creates the file if it doesn't exist. */
  async add(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryEntry> {
    await this.ensureFileExists();

    const now = Date.now();
    const fullEntry: MemoryEntry = {
      ...entry,
      id: generateMemoryId(),
      createdAt: now,
      updatedAt: now,
    };

    const existing = await this.load();
    existing.push(fullEntry);
    await this.save(existing);
    return fullEntry;
  }

  /**
   * Remove memory entries matching a search term.
   * Returns the number of entries removed.
   */
  async remove(searchTerm: string): Promise<number> {
    const existing = await this.load();
    const normalizedSearch = searchTerm.toLowerCase().trim();

    const filtered = existing.filter(entry => {
      const normalizedContent = entry.content.toLowerCase().trim();
      // Remove if content matches or contains the search term
      return !normalizedContent.includes(normalizedSearch);
    });

    const removedCount = existing.length - filtered.length;
    if (removedCount > 0) {
      await this.save(filtered);
    }

    return removedCount;
  }

  /**
   * Build the text to inject into the system prompt.
   * Returns null if memory is empty or disabled.
   */
  async buildInjectionText(): Promise<string | null> {
    const entries = await this.load();
    if (entries.length === 0) {
      return null;
    }

    const sections = this.groupByCategory(entries);
    let text = '';

    for (const section of sections) {
      const sectionText = `### ${section.category}\n${section.items.map(item => `- ${item}`).join('\n')}\n`;
      if (text.length + sectionText.length > this.options.maxInjectionChars) {
        // Truncate: add as much as fits
        const remaining = this.options.maxInjectionChars - text.length;
        if (remaining > 50) {
          text += sectionText.slice(0, remaining);
        }
        break;
      }
      text += sectionText;
    }

    return text.trim() || null;
  }

  private async ensureFileExists(): Promise<void> {
    if (!(await this.adapter.exists(this.options.filePath))) {
      await this.adapter.write(this.options.filePath, MEMORY_FILE_TEMPLATE);
    }
  }

  private parseMarkdown(content: string): MemoryEntry[] {
    const entries: MemoryEntry[] = [];
    const lines = content.split('\n');
    let currentCategory = 'General';
    let entryIndex = 0;

    for (const line of lines) {
      const trimmedLine = line.trim();

      // Skip empty lines, H1 title, metadata lines, and HTML comments
      if (
        !trimmedLine
        || trimmedLine.startsWith('# ')
        || trimmedLine.startsWith('This file stores')
        || trimmedLine.startsWith('<!--')
        || trimmedLine.startsWith('-->')
      ) {
        continue;
      }

      // H2 heading defines category
      const headingMatch = trimmedLine.match(/^##\s+(.+)$/);
      if (headingMatch) {
        currentCategory = headingMatch[1].trim();
        continue;
      }

      // List items (-, *, +) are memory entries
      const itemMatch = trimmedLine.match(/^[-*+]\s+(.+)$/);
      if (itemMatch) {
        const itemContent = itemMatch[1].trim();
        if (itemContent) {
          entries.push({
            id: `mem_parsed_${entryIndex++}`,
            category: currentCategory,
            content: itemContent,
            source: 'user-explicit',
            createdAt: 0,
            updatedAt: 0,
          });
        }
      }
    }

    return entries;
  }

  private serializeMarkdown(entries: MemoryEntry[]): string {
    const sections = this.groupByCategory(entries);

    // Ensure default categories exist even if empty
    const categorySet = new Set(sections.map(s => s.category));
    for (const cat of ['User Preferences', 'Project Context']) {
      if (!categorySet.has(cat)) {
        sections.push({ category: cat, items: [] });
      }
    }

    let content = '# Claudian Memory\n\n';
    content += 'This file stores long-term user preferences and context extracted from conversations.\n';
    content += 'You can edit this file directly to add, modify, or remove memories.\n\n';

    for (const section of sections) {
      content += `## ${section.category}\n`;
      for (const item of section.items) {
        content += `- ${item}\n`;
      }
      content += '\n';
    }

    return content;
  }

  private groupByCategory(entries: MemoryEntry[]): ParsedSection[] {
    const map = new Map<string, string[]>();
    for (const entry of entries) {
      const items = map.get(entry.category) || [];
      items.push(entry.content);
      map.set(entry.category, items);
    }

    return Array.from(map.entries()).map(([category, items]) => ({
      category,
      items,
    }));
  }
}
