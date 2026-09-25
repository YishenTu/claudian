import { unwatchFile,watchFile } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseOpencodeConfig, resolveOpencodeConfigPath, writeIfChanged } from '../runtime/OpencodeLaunchArtifacts';
import { isRecord } from './OpencodeHTTPClient';

/** Writable explicit-config layer; user files are read, never edited. */
export class OpencodeServerConfig {
  private readonly agents = new Map<string, Record<string, unknown>>();
  private writes: Promise<void> = Promise.resolve();
  private disposed = false;
  private watcher?: () => void;
  private readonly source: string | undefined;

  constructor(readonly file: string, cwd: string, private readonly environment: NodeJS.ProcessEnv) {
    this.source = resolveOpencodeConfigPath(environment.OPENCODE_CONFIG, cwd);
  }

  async initialize(onError: (error: Error) => void): Promise<void> {
    await this.write();
    if (this.source) {
      this.watcher = () => { void this.write().catch(error => onError(error instanceof Error ? error : new Error(String(error)))); };
      watchFile(this.source, { persistent: false, interval: 250 }, this.watcher);
    }
  }

  async add(agents: Record<string, Record<string, unknown>>): Promise<void> {
    for (const [id, agent] of Object.entries(agents)) this.agents.set(id, agent);
    await this.write();
  }

  async remove(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    for (const id of ids) this.agents.delete(id);
    await this.write();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.source && this.watcher) unwatchFile(this.source, this.watcher);
    await this.writes.catch(() => undefined);
    await fs.rm(path.dirname(this.file), { recursive: true, force: true });
  }

  private write(): Promise<void> {
    const write = this.writes.catch(() => undefined).then(async () => {
      if (this.disposed) return;
      const base = this.source
        ? await parseOpencodeConfig(await fs.readFile(this.source, 'utf8'), this.source, this.environment, path.dirname(this.source))
        : {};
      // Native resolves local plugin packages relative to their config document.
      // Keep that meaning when layering the explicit document in managed storage.
      for (const key of ['plugin', 'plugins']) {
        if (!Array.isArray(base[key]) || !this.source) continue;
        base[key] = (base[key] as unknown[]).map(value => {
          const resolve = (value: unknown): unknown => typeof value === 'string' && (value.startsWith('./') || value.startsWith('../'))
            ? pathToFileURL(path.resolve(path.dirname(this.source!), value)).href : value;
          if (isRecord(value)) return { ...value, package: resolve(value.package) };
          return Array.isArray(value) ? [resolve(value[0]), ...(value as unknown[]).slice(1)] : resolve(value);
        });
      }
      const config = { ...base, agents: { ...(isRecord(base.agents) ? base.agents : {}), ...Object.fromEntries(this.agents) } };
      // File/environment substitutions have already been resolved, including user text.
      await writeIfChanged(this.file, `${JSON.stringify(config, null, 2).replace(/\{(env|file):/g, '\\u007b$1:')}\n`);
    });
    this.writes = write;
    return write;
  }
}

export async function createOpencodeServerConfig(cwd: string, environment: NodeJS.ProcessEnv): Promise<OpencodeServerConfig> {
  // Explicit config can contain credentials; never copy it into a synced vault.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-opencode-'));
  return new OpencodeServerConfig(path.join(root, 'config.json'), cwd, environment);
}
