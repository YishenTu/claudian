import type { App, TFile } from 'obsidian';

export interface VaultRetrievalResult {
  path: string;
  heading: string;
  excerpt: string;
  score: number;
  matchedTerms: string[];
  modifiedAt: number;
}

export interface VaultRetrievalOptions {
  limit?: number;
  maxExcerptLength?: number;
}

interface IndexedBlock {
  heading: string;
  text: string;
  tokens: Set<string>;
}

interface IndexedFile {
  mtime: number;
  size: number;
  blocks: IndexedBlock[];
}

const DEFAULT_LIMIT = 8;
const DEFAULT_EXCERPT_LENGTH = 420;

/**
 * Local-first vault retrieval for search and source-backed insights.
 *
 * The first implementation deliberately avoids a remote embedding service:
 * lexical overlap, heading/path boosts, link matches, and recency provide a
 * deterministic hybrid ranking while keeping the index private to Obsidian.
 */
export class VaultRetrievalService {
  private readonly index = new Map<string, IndexedFile>();

  constructor(private readonly app: App) {}

  async search(
    query: string,
    options: VaultRetrievalOptions = {},
  ): Promise<VaultRetrievalResult[]> {
    const terms = tokenize(query);
    if (terms.length === 0) return [];

    const files = this.app.vault.getMarkdownFiles();
    const results: VaultRetrievalResult[] = [];
    const querySet = new Set(terms);
    const now = Date.now();
    const maxExcerptLength = options.maxExcerptLength ?? DEFAULT_EXCERPT_LENGTH;

    for (const file of files) {
      const indexed = await this.ensureIndexed(file);
      for (const block of indexed.blocks) {
        const matchedTerms = terms.filter(term => block.tokens.has(term));
        if (matchedTerms.length === 0) continue;

        const normalizedPath = file.path.toLowerCase();
        const normalizedHeading = block.heading.toLowerCase();
        const normalizedText = block.text.toLowerCase();
        const lexicalScore = matchedTerms.length / terms.length;
        const phraseBoost = normalizedText.includes(query.trim().toLowerCase()) ? 0.35 : 0;
        const headingBoost = terms.some(term => normalizedHeading.includes(term)) ? 0.3 : 0;
        const pathBoost = terms.some(term => normalizedPath.includes(term)) ? 0.12 : 0;
        const linkBoost = terms.some(term => normalizedText.includes(`[[${term}`)) ? 0.16 : 0;
        const recencyBoost = Math.max(0, 0.08 - ((now - indexed.mtime) / (1000 * 60 * 60 * 24 * 365)) * 0.08);
        const semanticOverlap = jaccardScore(querySet, block.tokens);
        const score = lexicalScore + phraseBoost + headingBoost + pathBoost + linkBoost + recencyBoost + semanticOverlap * 0.2;

        results.push({
          path: file.path,
          heading: block.heading,
          excerpt: createExcerpt(block.text, terms, maxExcerptLength),
          score,
          matchedTerms: [...new Set(matchedTerms)],
          modifiedAt: indexed.mtime,
        });
      }
    }

    return results
      .sort((left, right) => right.score - left.score || right.modifiedAt - left.modifiedAt)
      .slice(0, Math.max(1, options.limit ?? DEFAULT_LIMIT));
  }

  async buildInsightPrompt(
    topic: string,
    options: VaultRetrievalOptions = {},
  ): Promise<{ prompt: string; results: VaultRetrievalResult[] }> {
    const query = topic.trim() || this.app.workspace.getActiveFile()?.basename || '';
    const results = await this.search(query, { ...options, limit: options.limit ?? 6 });
    if (results.length === 0) {
      return {
        prompt: `I want to explore the topic "${query || 'my vault'}", but no matching Markdown sources were found. Ask me for the missing context before making claims.`,
        results,
      };
    }

    const sources = results
      .map((result, index) => (
        `[${index + 1}] ${result.path}${result.heading ? `#${result.heading}` : ''}\n${result.excerpt}`
      ))
      .join('\n\n');

    return {
      prompt: [
        'Act as a source-grounded knowledge partner for my Obsidian vault.',
        `Explore this topic: ${query || 'the related ideas in my vault'}`,
        'Use only the supplied sources for factual claims. Identify three useful connections or changes over time, call out uncertainty, and end with three concrete follow-up questions. Cite sources as [n].',
        '',
        'Sources:',
        sources,
      ].join('\n'),
      results,
    };
  }

  invalidate(path?: string): void {
    if (path) {
      this.index.delete(path);
      return;
    }
    this.index.clear();
  }

  private async ensureIndexed(file: TFile): Promise<IndexedFile> {
    const cached = this.index.get(file.path);
    if (cached && cached.mtime === file.stat.mtime && cached.size === file.stat.size) {
      return cached;
    }

    const content = await this.app.vault.cachedRead(file);
    const indexed: IndexedFile = {
      mtime: file.stat.mtime,
      size: file.stat.size,
      blocks: splitIntoBlocks(content),
    };
    this.index.set(file.path, indexed);
    return indexed;
  }
}

function splitIntoBlocks(content: string): IndexedBlock[] {
  const lines = content.split(/\r?\n/);
  const blocks: IndexedBlock[] = [];
  let heading = '';
  let buffer: string[] = [];

  const flush = (): void => {
    const text = buffer.join('\n').trim();
    if (text) {
      blocks.push({ heading, text, tokens: new Set(tokenize(`${heading} ${text}`)) });
    }
    buffer = [];
  };

  for (const line of lines) {
    const match = line.match(/^#{1,6}\s+(.+?)\s*#*$/);
    if (match) {
      flush();
      heading = match[1].trim();
      continue;
    }
    if (line.trim() === '---' && buffer.length > 0) {
      flush();
      continue;
    }
    buffer.push(line);
  }
  flush();

  return blocks.length > 0
    ? blocks
    : [{ heading: '', text: content.trim(), tokens: new Set(tokenize(content)) }].filter(block => block.text);
}

function tokenize(value: string): string[] {
  return [...new Set(
    value
      .toLowerCase()
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
      .split(/\s+/)
      .map(token => token.trim())
      .filter(token => token.length >= 2),
  )];
}

function jaccardScore(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const term of left) {
    if (right.has(term)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

function createExcerpt(text: string, terms: string[], maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;

  const lower = normalized.toLowerCase();
  const firstMatch = terms
    .map(term => lower.indexOf(term))
    .filter(index => index >= 0)
    .sort((left, right) => left - right)[0] ?? 0;
  const start = Math.max(0, Math.min(firstMatch - Math.floor(maxLength / 3), normalized.length - maxLength));
  const excerpt = normalized.slice(start, start + maxLength).trim();
  return `${start > 0 ? '…' : ''}${excerpt}${start + maxLength < normalized.length ? '…' : ''}`;
}

