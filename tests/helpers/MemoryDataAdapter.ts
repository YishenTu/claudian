import { AGENT_SKILLS_ROOT } from '@/core/skills/AgentSkillRepository';

type Node = { type: 'file'; content: string } | { type: 'folder' };

export class MemoryDataAdapter {
  readonly nodes = new Map<string, Node>();
  readonly trashed: string[] = [];
  beforeWrite?: (path: string, content: string) => void | Promise<void>;
  beforeMkdir?: (path: string) => void | Promise<void>;

  constructor() {
    this.nodes.set('.agents', { type: 'folder' });
    this.nodes.set(AGENT_SKILLS_ROOT, { type: 'folder' });
  }

  addFolder(path: string): void {
    this.nodes.set(path, { type: 'folder' });
  }

  addFile(path: string, content: string): void {
    this.nodes.set(path, { type: 'file', content });
  }

  async exists(path: string): Promise<boolean> {
    return this.nodes.has(path);
  }

  async stat(path: string): Promise<{ type: 'file' | 'folder'; ctime: number; mtime: number; size: number } | null> {
    const node = this.nodes.get(path);
    return node ? { type: node.type, ctime: 0, mtime: 0, size: 0 } : null;
  }

  async mkdir(path: string): Promise<void> {
    await this.beforeMkdir?.(path);
    if (this.nodes.has(path)) throw new Error(`EEXIST: ${path}`);
    this.nodes.set(path, { type: 'folder' });
  }

  async read(path: string): Promise<string> {
    const node = this.nodes.get(path);
    if (node?.type !== 'file') throw new Error(`Not a file: ${path}`);
    return node.content;
  }

  async write(path: string, content: string): Promise<void> {
    await this.beforeWrite?.(path, content);
    this.nodes.set(path, { type: 'file', content });
  }

  async list(folder: string): Promise<{ files: string[]; folders: string[] }> {
    const files: string[] = [];
    const folders: string[] = [];
    for (const [candidate, node] of this.nodes) {
      if (candidate === folder || candidate.slice(0, candidate.lastIndexOf('/')) !== folder) continue;
      (node.type === 'file' ? files : folders).push(candidate);
    }
    return { files, folders };
  }

  async rename(source: string, target: string): Promise<void> {
    if (this.nodes.has(target)) throw new Error(`EEXIST: ${target}`);
    const entries = [...this.nodes.entries()].filter(([candidate]) => (
      candidate === source || candidate.startsWith(`${source}/`)
    ));
    if (entries.length === 0) throw new Error(`Missing: ${source}`);
    for (const [candidate] of entries) this.nodes.delete(candidate);
    for (const [candidate, node] of entries) {
      this.nodes.set(`${target}${candidate.slice(source.length)}`, node);
    }
  }

  async rmdir(folder: string): Promise<void> {
    if ([...this.nodes.keys()].some(candidate => candidate.startsWith(`${folder}/`))) {
      throw new Error(`Directory not empty: ${folder}`);
    }
    this.nodes.delete(folder);
  }

  async remove(path: string): Promise<void> {
    this.nodes.delete(path);
  }

  async trashSystem(path: string): Promise<boolean> {
    this.trashed.push(path);
    for (const candidate of [...this.nodes.keys()]) {
      if (candidate === path || candidate.startsWith(`${path}/`)) this.nodes.delete(candidate);
    }
    return true;
  }

  async trashLocal(): Promise<void> {
    throw new Error('Unexpected local trash');
  }
}
