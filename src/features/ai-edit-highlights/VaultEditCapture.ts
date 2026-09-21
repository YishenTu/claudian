import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { deflateRaw, inflateRawSync } from 'node:zlib';

import type { App } from 'obsidian';

import { normalizeReviewText } from './DocumentDiff';

const compress = promisify(deflateRaw);

/** One compressed baseline per path, shared by active turns and released at idle. */
export class VaultEditCapture {
  private readonly turns = new Set<string>();
  private readonly baseline = new Map<string, Uint8Array>();
  private readonly pendingSaves = new Map<string, { hashes: Set<string>; latest: string }>();
  private readonly requestedPaths = new Set<string>();
  private readonly unavailable = new Set<string>();
  private readonly renaming = new Set<string>();
  private pending = Promise.resolve();
  private initialized = false;
  private ready = false;
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly app: App,
    private readonly onChange: (path: string, before: string, after: string) => void,
    private readonly onError: () => void,
    private readonly editorText: (path: string) => string | null,
  ) {}

  get active(): boolean { return this.turns.size > 0; }

  begin(id: string): Promise<void> {
    if (this.disposed || this.turns.has(id)) return this.pending;
    this.turns.add(id);
    const generation = this.generation;
    return this.enqueue(async () => {
      if (this.initialized) return;
      this.initialized = true;
      // Sequential reads bound peak plaintext to one note. Do not evict originals:
      // an arbitrary shell command can modify any Markdown file in the Vault.
      for (const file of this.app.vault.getMarkdownFiles()) {
        if (this.disposed || !this.active || generation !== this.generation) return;
        try {
          const disk = normalizeReviewText(await this.app.vault.read(file));
          const text = this.editorText(file.path) ?? disk;
          const packed = await pack(text);
          if (this.disposed || !this.active || generation !== this.generation) return;
          this.baseline.set(file.path, packed);
          if (text !== disk) this.rememberManualSave(file.path, disk, text);
        } catch {
          this.unavailable.add(file.path);
          this.onError();
        }
      }
      if (this.active && generation === this.generation) this.ready = true;
    });
  }

  changed(path: string): void {
    if (!this.active || !path.toLowerCase().endsWith('.md') || this.requestedPaths.has(path)) return;
    this.requestedPaths.add(path);
    const generation = this.generation;
    void this.enqueue(async () => {
      this.requestedPaths.delete(path);
      if (!this.active || generation !== this.generation) return;
      await this.reconcile(path);
    });
  }

  finish(id: string): Promise<void> {
    if (!this.turns.has(id)) return this.pending;
    return this.enqueue(async () => {
      try {
        // Always verify at settlement, including cancellation and failed tools.
        // Event delivery alone is not a reliable final-content boundary.
        const paths = new Set([
          ...this.baseline.keys(),
          ...this.app.vault.getMarkdownFiles().map(file => file.path),
        ]);
        for (const path of paths) {
          if (this.disposed) return;
          await this.reconcile(path);
        }
      } finally {
        this.turns.delete(id);
        if (!this.active) this.release();
      }
    });
  }

  manualEdit(path: string, before: string, after: string, apply: () => void): void {
    if (!this.active) { apply(); return; }
    const wasReady = this.ready;
    const generation = this.generation;
    void this.enqueue(async () => {
      if (!this.active || generation !== this.generation) { apply(); return; }
      // First account for AI edits that reached the editor before a Vault event.
      const previous = this.baseline.get(path);
      const original = previous ? unpack(previous) : '';
      if (wasReady && !this.unavailable.has(path) && original !== before) this.onChange(path, original, before);
      this.rememberManualSave(path, original, before, after);
      const packed = await pack(after);
      if (this.disposed) return;
      this.baseline.set(path, packed);
      this.unavailable.delete(path);
      apply();
    });
  }

  rename(oldPath: string, path: string): void {
    if (!this.active) return;
    this.renaming.add(oldPath);
    const generation = this.generation;
    void this.enqueue(async () => {
      if (!this.active || generation !== this.generation) return;
      const previous = this.baseline.get(oldPath);
      this.baseline.delete(oldPath);
      const pendingSave = this.pendingSaves.get(oldPath);
      this.pendingSaves.delete(oldPath);
      const unavailable = this.unavailable.delete(oldPath);
      this.renaming.delete(oldPath);
      if (!path.toLowerCase().endsWith('.md')) return;
      if (unavailable) this.unavailable.add(path);
      if (previous) this.baseline.set(path, previous);
      if (pendingSave) this.pendingSaves.set(path, pendingSave);
      await this.reconcile(path);
    });
  }

  async flush(): Promise<void> {
    let pending: Promise<void>;
    do {
      pending = this.pending;
      await pending;
    } while (pending !== this.pending);
  }

  cancel(): void {
    this.turns.clear();
    this.release();
  }

  dispose(): void {
    this.disposed = true;
    this.turns.clear();
    this.release();
  }

  private release(): void {
    this.baseline.clear();
    this.pendingSaves.clear();
    this.requestedPaths.clear();
    this.unavailable.clear();
    this.renaming.clear();
    this.initialized = false;
    this.ready = false;
    this.generation++;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    this.pending = this.pending.then(async () => {
      if (!this.disposed) await operation();
    }).catch(() => { if (!this.disposed) this.onError(); });
    return this.pending;
  }

  private async reconcile(path: string): Promise<void> {
    if (this.renaming.has(path)) return;
    try {
      const file = this.app.vault.getFileByPath(path);
      const text = file ? normalizeReviewText(await this.app.vault.read(file)) : '';
      const pendingSave = this.pendingSaves.get(path);
      if (pendingSave) {
        const hash = fingerprint(text);
        if (pendingSave.hashes.has(hash)) {
          if (hash === pendingSave.latest) this.pendingSaves.delete(path);
          return;
        }
      }
      const packed = await pack(text);
      if (this.disposed || this.renaming.has(path)) return;
      const previous = this.baseline.get(path);
      this.pendingSaves.delete(path);
      if (previous && equalBytes(previous, packed)) return;
      if (!this.unavailable.has(path) && (previous || file)) {
        this.onChange(path, previous ? unpack(previous) : '', text);
      }
      this.unavailable.delete(path);
      if (file) this.baseline.set(path, packed);
      else this.baseline.delete(path);
    } catch { this.onError(); }
  }

  private rememberManualSave(path: string, ...versions: string[]): void {
    const hashes = this.pendingSaves.get(path)?.hashes ?? new Set<string>();
    const fingerprints = versions.map(fingerprint);
    fingerprints.forEach(hash => hashes.add(hash));
    // Keep only hashes of autosave revisions, never another full-text history.
    this.pendingSaves.set(path, { hashes, latest: fingerprints[fingerprints.length - 1] });
  }
}

function fingerprint(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('base64');
}

async function pack(text: string): Promise<Uint8Array> {
  // Copy out of zlib's oversized output slab; retain exactly the compressed bytes.
  return Uint8Array.from(await compress(Buffer.from(text, 'utf8')));
}

function unpack(bytes: Uint8Array): string {
  return inflateRawSync(bytes).toString('utf8');
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
