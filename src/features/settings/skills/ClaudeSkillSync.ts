import { createHash } from 'node:crypto';
import * as path from 'node:path';

import type { FolderLinkState, VaultFileAdapter } from '@/core/storage/VaultFileAdapter';

import type { AgentSkillInput } from './AgentSkill';
import {
  AgentSkillCodecError,
  extraFrontmatterKeys,
  parseLenientAgentSkillMarkdown,
  serializeAgentSkillMarkdown,
} from './AgentSkillCodec';
import {
  AGENT_SKILLS_ROOT,
  AgentSkillRepository,
  CLAUDE_COMMANDS_ROOT,
  CLAUDE_SKILLS_ROOT,
} from './AgentSkillRepository';
import { ClaudeCommandRepository, commandNameFromPath, commandSkillName } from './ClaudeCommandRepository';
import { collectAgentSkillInputErrors } from './validateAgentSkill';

const SKILL_FILENAME = 'SKILL.md';
const FRONTMATTER_START = /^---\r?\n/;

/**
 * - `package`: a `.claude/skills/<name>` folder with `SKILL.md`; moves into `.agents/skills`.
 * - `command`: a `.claude/commands/**.md` file; becomes a new shared skill.
 * - `unreadable`: a `.claude/skills` package whose SKILL.md frontmatter cannot be parsed;
 *   it is trashed only when the user chooses to discard it.
 * - `link`: a per-skill link inside `.claude/skills`; only the link is removed.
 * - `leftover`: anything else inside `.claude/skills`, including folders whose SKILL.md is
 *   missing or has no frontmatter; moved to trash so the folder can become the link.
 */
export type SkillSyncItemKind = 'package' | 'command' | 'unreadable' | 'link' | 'leftover';

export type SkillSyncIssue =
  | { code: 'already-shared' }
  | { code: 'unreadable'; message: string }
  | { code: 'dropped-frontmatter'; keys: string[] }
  | { code: 'claude-syntax'; matches: string[] }
  | { code: 'extra-files'; count: number };

export interface SkillSyncItem {
  /** Vault-relative source path; unique within a plan. */
  id: string;
  kind: SkillSyncItemKind;
  proposedName: string;
  description: string;
  instructions: string;
  fingerprint: string;
  issues: SkillSyncIssue[];
}

export interface SkillSyncPlan {
  state: FolderLinkState;
  items: SkillSyncItem[];
  /** Lowercase names of packages already in `.agents/skills`. */
  sharedNames: string[];
}

export type SkillSyncResolution =
  | { action: 'apply'; name?: string; description?: string; replaceExisting?: boolean }
  | { action: 'skip' };

export type SkillSyncResolutions = ReadonlyMap<string, SkillSyncResolution>;

export type SkillSyncBlockingReason =
  | { code: 'invalid'; field: 'name' | 'description' | 'instructions'; message: string }
  | { code: 'name-conflict'; with: 'shared' | 'item'; name: string }
  | { code: 'unreadable'; message: string };

export interface SkillSyncResult {
  linked: boolean;
  moved: string[];
  converted: string[];
  trashed: string[];
  unlinked: string[];
  failed: Array<{ id: string; message: string }>;
}

export class SkillSyncStaleError extends Error {
  constructor() {
    super('The vault changed since the preview; run Sync again');
    this.name = 'SkillSyncStaleError';
  }
}

export class SkillSyncBlockedError extends Error {
  constructor(readonly blocking: ReadonlyMap<string, SkillSyncBlockingReason[]>) {
    super('Resolve every blocking item before syncing');
    this.name = 'SkillSyncBlockedError';
  }
}

const CLAUDE_SYNTAX_PATTERNS = [
  /\$ARGUMENTS\b/g,
  /\$\d+/g,
  /!`[^`\n]+`/g,
  /(?<=^|\s)@[\w.\-/]*[./][\w.\-/]*/gm,
];

function digest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function findClaudeSyntax(body: string): string[] {
  const matches = new Set<string>();
  for (const pattern of CLAUDE_SYNTAX_PATTERNS) {
    for (const match of body.matchAll(pattern)) matches.add(match[0]);
  }
  return [...matches];
}

function fileChanged(): Error {
  return new Error('Changed since the preview');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMovable(item: SkillSyncItem): boolean {
  return (item.kind === 'package' || item.kind === 'command')
    && !item.issues.some(issue => issue.code === 'already-shared');
}

/**
 * Unifies Claude's vault skills with the shared `.agents/skills` folder and
 * replaces `.claude/skills` with a folder link. The link state is always read
 * from disk because it is per device.
 */
export class ClaudeSkillSync {
  private readonly sharedSkills: AgentSkillRepository;
  private readonly commands: ClaudeCommandRepository;

  constructor(private readonly files: VaultFileAdapter) {
    this.sharedSkills = new AgentSkillRepository(files);
    this.commands = new ClaudeCommandRepository(files);
  }

  readState(): Promise<FolderLinkState> {
    return this.files.inspectFolderLink(CLAUDE_SKILLS_ROOT, AGENT_SKILLS_ROOT);
  }

  async plan(): Promise<SkillSyncPlan> {
    const state = await this.readState();
    if (state === 'other') throw new Error(`${CLAUDE_SKILLS_ROOT} is a file; move it away before syncing`);
    const sharedNames = await this.#listSharedNames();
    // Commands convert whenever Claude's folder is about to become the link, even if it does not exist yet.
    if (state !== 'folder' && state !== 'missing') return { state, items: [], sharedNames };

    const items = [
      ...state === 'folder' ? await this.#planClaudeSkills() : [],
      ...await this.#planCommands(),
    ];
    return { state, items, sharedNames };
  }

  /** Items that still need a user decision before `execute` may run. */
  getBlockingReasons(
    plan: SkillSyncPlan,
    resolutions: SkillSyncResolutions,
  ): Map<string, SkillSyncBlockingReason[]> {
    const blocking = new Map<string, SkillSyncBlockingReason[]>();
    const add = (id: string, reason: SkillSyncBlockingReason): void => {
      blocking.set(id, [...blocking.get(id) ?? [], reason]);
    };
    const shared = new Set(plan.sharedNames);
    const claimed = new Map<string, string[]>();

    for (const item of plan.items) {
      const resolution = resolutions.get(item.id);
      if (resolution?.action === 'skip') continue;
      const unreadable = item.issues.find(issue => issue.code === 'unreadable');
      if (unreadable) {
        add(item.id, { code: 'unreadable', message: unreadable.message });
        continue;
      }
      if (!isMovable(item)) continue;
      const input = this.#resolveInput(item, resolution);
      for (const error of collectAgentSkillInputErrors(input)) {
        add(item.id, { code: 'invalid', field: error.field, message: error.message });
      }
      const key = input.name.toLowerCase();
      if (shared.has(key) && !(resolution?.action === 'apply' && resolution.replaceExisting)) {
        add(item.id, { code: 'name-conflict', with: 'shared', name: input.name });
      }
      claimed.set(key, [...claimed.get(key) ?? [], item.id]);
    }
    for (const [name, ids] of claimed) {
      if (ids.length < 2) continue;
      for (const id of ids) add(id, { code: 'name-conflict', with: 'item', name });
    }
    return blocking;
  }

  async execute(plan: SkillSyncPlan, resolutions: SkillSyncResolutions): Promise<SkillSyncResult> {
    const result: SkillSyncResult = {
      linked: false, moved: [], converted: [], trashed: [], unlinked: [], failed: [],
    };
    const state = await this.readState();
    if (state !== plan.state) throw new SkillSyncStaleError();

    if (state === 'linked') return { ...result, linked: true };
    if (state === 'other') {
      throw new Error(`${CLAUDE_SKILLS_ROOT} is a file; move it away before syncing`);
    }
    if (state === 'foreign-link' || state === 'broken-link') {
      await this.files.removeFolderLink(CLAUDE_SKILLS_ROOT);
      await this.#link();
      return { ...result, linked: true };
    }
    const blocking = this.getBlockingReasons(plan, resolutions);
    if (blocking.size > 0) throw new SkillSyncBlockedError(blocking);

    for (const item of plan.items) {
      try {
        await this.#executeItem(item, resolutions.get(item.id), result);
      } catch (error) {
        result.failed.push({ id: item.id, message: errorMessage(error) });
      }
    }
    try {
      await this.#removeEmptyCommandsRoot();
    } catch (error) {
      result.failed.push({ id: CLAUDE_COMMANDS_ROOT, message: errorMessage(error) });
    }
    if (result.failed.length > 0) return result;

    if (state === 'folder') {
      if ((await this.files.listManagedFolderEntries(CLAUDE_SKILLS_ROOT)).length > 0) {
        result.failed.push({ id: CLAUDE_SKILLS_ROOT, message: `${CLAUDE_SKILLS_ROOT} is not empty` });
        return result;
      }
      await this.files.removeManagedFolderIfEmpty(CLAUDE_SKILLS_ROOT);
    }
    await this.#link();
    return { ...result, linked: true };
  }

  async #executeItem(
    item: SkillSyncItem,
    resolution: SkillSyncResolution | undefined,
    result: SkillSyncResult,
  ): Promise<void> {
    if (item.kind === 'link') {
      await this.files.removeFolderLink(item.id);
      result.unlinked.push(item.id);
      return;
    }
    if (item.kind === 'leftover') {
      await this.files.trash(item.id);
      result.trashed.push(item.id);
      return;
    }
    const alreadyShared = item.issues.some(issue => issue.code === 'already-shared');
    if (resolution?.action === 'skip' || alreadyShared) {
      // A copy discarded without asking must still match its shared skill.
      if (resolution?.action !== 'skip' && !await this.#isIdenticalToShared(item.id)) throw fileChanged();
      // A skipped command stays where it is.
      if (item.kind !== 'command') {
        await this.files.trash(item.id);
        result.trashed.push(item.id);
      }
      return;
    }

    const input = this.#resolveInput(item, resolution);
    if (item.kind === 'package') {
      const skillFile = `${item.id}/${SKILL_FILENAME}`;
      if (digest(await this.files.readManagedFile(skillFile)) !== item.fingerprint) {
        throw fileChanged();
      }
      await this.files.ensureManagedFolder(AGENT_SKILLS_ROOT);
      if (resolution?.action === 'apply' && resolution.replaceExisting) await this.#trashShared(input.name);
      const target = `${AGENT_SKILLS_ROOT}/${input.name}`;
      const targetFile = `${target}/${SKILL_FILENAME}`;
      await this.files.relocateManagedPackageNoReplace(item.id, target);
      try {
        await this.files.writeManagedFile(targetFile, serializeAgentSkillMarkdown({}, input));
      } catch (error) {
        // Managed writes are atomic, so SKILL.md still holds the original content.
        // Put the package back so a re-run sees the same item.
        try {
          await this.files.relocateManagedPackageNoReplace(target, item.id);
        } catch (rollbackError) {
          throw new Error(
            `${errorMessage(error)}; could not move the package back: ${errorMessage(rollbackError)}`,
            { cause: rollbackError },
          );
        }
        throw error;
      }
      result.moved.push(item.id);
      return;
    }

    // Trashing the command re-checks its revision and removes emptied subfolders.
    const commandName = commandNameFromPath(item.id);
    await this.commands.assertRevision(commandName, item.fingerprint);
    if (resolution?.action === 'apply' && resolution.replaceExisting) await this.#trashShared(input.name);
    await this.sharedSkills.create(input);
    await this.commands.trash(commandName, item.fingerprint);
    result.converted.push(item.id);
  }

  #resolveInput(item: SkillSyncItem, resolution: SkillSyncResolution | undefined): AgentSkillInput {
    const apply = resolution?.action === 'apply' ? resolution : undefined;
    return {
      name: (apply?.name ?? item.proposedName).trim(),
      description: (apply?.description ?? item.description).trim(),
      instructions: item.instructions,
    };
  }

  /** Trashes every shared package matching `name` case-insensitively, as conflicts are detected. */
  async #trashShared(name: string): Promise<void> {
    const key = name.toLowerCase();
    const listing = await this.files.listManagedFolder(AGENT_SKILLS_ROOT);
    for (const folder of listing.folders) {
      if (path.posix.dirname(folder) === AGENT_SKILLS_ROOT && path.posix.basename(folder).toLowerCase() === key) {
        await this.files.trash(folder);
      }
    }
  }

  async #link(): Promise<void> {
    await this.files.ensureManagedFolder(AGENT_SKILLS_ROOT);
    await this.files.createFolderLink(CLAUDE_SKILLS_ROOT, AGENT_SKILLS_ROOT);
  }

  async #listSharedNames(): Promise<string[]> {
    const exists = await this.files.verifyManagedPath(AGENT_SKILLS_ROOT, {
      expectedType: 'folder',
      allowMissing: true,
    });
    if (!exists) return [];
    const listing = await this.files.listManagedFolder(AGENT_SKILLS_ROOT);
    return listing.folders
      .filter(folder => path.posix.dirname(folder) === AGENT_SKILLS_ROOT)
      .map(folder => path.posix.basename(folder).toLowerCase());
  }

  async #planClaudeSkills(): Promise<SkillSyncItem[]> {
    // Entries are read without following links, so a dangling per-skill link is planned, not fatal.
    const entries = (await this.files.listManagedFolderEntries(CLAUDE_SKILLS_ROOT))
      .sort((left, right) => left.path.localeCompare(right.path));
    const items: SkillSyncItem[] = [];
    for (const { path: entry, type } of entries) {
      const name = path.posix.basename(entry);
      if (type === 'link') {
        const state = await this.files.inspectFolderLink(entry, `${AGENT_SKILLS_ROOT}/${name}`);
        items.push(this.#simpleItem(entry, 'link', state === 'linked' ? name : ''));
        continue;
      }
      const hasSkillFile = type === 'folder' && await this.files.verifyManagedPath(
        `${entry}/${SKILL_FILENAME}`,
        { expectedType: 'file', allowMissing: true },
      ).catch(() => false);
      const skill = hasSkillFile ? await this.#planPackage(entry, name) : null;
      items.push(skill ?? this.#simpleItem(entry, 'leftover', ''));
    }
    return items;
  }

  /** Returns null when SKILL.md has no frontmatter, so the folder is not a skill. */
  async #planPackage(directory: string, directoryName: string): Promise<SkillSyncItem | null> {
    const raw = await this.files.readManagedFile(`${directory}/${SKILL_FILENAME}`);
    let parsed;
    try {
      parsed = parseLenientAgentSkillMarkdown(raw, directoryName);
    } catch (error) {
      if (!(error instanceof AgentSkillCodecError)) throw error;
      if (!FRONTMATTER_START.test(raw)) return null;
      // Frontmatter the user meant to write but YAML rejects: never trash it without asking.
      return {
        ...this.#simpleItem(directory, 'unreadable', directoryName),
        fingerprint: digest(raw),
        issues: [{ code: 'unreadable', message: error.message }],
      };
    }
    const frontmatterName = typeof parsed.frontmatter.name === 'string' ? parsed.frontmatter.name.trim() : '';
    const item: SkillSyncItem = {
      id: directory,
      kind: 'package',
      proposedName: frontmatterName || directoryName,
      description: parsed.description,
      instructions: parsed.instructions,
      fingerprint: digest(raw),
      issues: [],
    };
    this.#addContentIssues(item, parsed.frontmatter);

    const packageFiles = await this.#listPackageFiles(directory);
    const extraFiles = packageFiles.filter(file => file !== SKILL_FILENAME);
    if (extraFiles.length > 0) item.issues.push({ code: 'extra-files', count: extraFiles.length });
    if (await this.#isIdenticalToShared(directory, packageFiles)) {
      item.issues.push({ code: 'already-shared' });
    }
    return item;
  }

  async #planCommands(): Promise<SkillSyncItem[]> {
    const { commands } = await this.commands.list();
    return commands.map(command => {
      const item: SkillSyncItem = {
        id: command.filePath,
        kind: 'command',
        proposedName: commandSkillName(command.name),
        description: command.description,
        instructions: command.instructions,
        fingerprint: command.revision,
        issues: [],
      };
      this.#addContentIssues(item, command.frontmatter);
      return item;
    });
  }

  #addContentIssues(item: SkillSyncItem, frontmatter: Record<string, unknown>): void {
    const dropped = extraFrontmatterKeys(frontmatter);
    if (dropped.length > 0) item.issues.push({ code: 'dropped-frontmatter', keys: dropped });
    const syntax = findClaudeSyntax(item.instructions);
    if (syntax.length > 0) item.issues.push({ code: 'claude-syntax', matches: syntax });
  }

  #simpleItem(id: string, kind: 'unreadable' | 'link' | 'leftover', proposedName: string): SkillSyncItem {
    return { id, kind, proposedName, description: '', instructions: '', fingerprint: '', issues: [] };
  }

  async #isIdenticalToShared(
    directory: string,
    packageFiles?: string[],
  ): Promise<boolean> {
    const sharedDirectory = `${AGENT_SKILLS_ROOT}/${path.posix.basename(directory)}`;
    const sharedExists = await this.files.verifyManagedPath(sharedDirectory, {
      expectedType: 'folder',
      allowMissing: true,
    }).catch(() => false);
    if (!sharedExists) return false;
    const files = packageFiles ?? await this.#listPackageFiles(directory);
    const sharedFiles = await this.#listPackageFiles(sharedDirectory);
    if (sharedFiles.join('\n') !== files.join('\n')) return false;
    for (const file of files) {
      const [left, right] = await Promise.all([
        this.files.readManagedBinary(`${directory}/${file}`),
        this.files.readManagedBinary(`${sharedDirectory}/${file}`),
      ]);
      if (!Buffer.from(left).equals(Buffer.from(right))) return false;
    }
    return true;
  }

  /** Package-relative file paths, sorted. */
  async #listPackageFiles(directory: string): Promise<string[]> {
    return (await this.#listFilesRecursive(directory))
      .map(file => file.slice(directory.length + 1))
      .sort((left, right) => left.localeCompare(right));
  }

  async #listFilesRecursive(folder: string): Promise<string[]> {
    const listing = await this.files.listManagedFolder(folder);
    const nested = await Promise.all(
      listing.folders
        .filter(child => path.posix.dirname(child) === folder)
        .map(child => this.#listFilesRecursive(child)),
    );
    return [
      ...listing.files.filter(file => path.posix.dirname(file) === folder),
      ...nested.flat(),
    ];
  }

  async #removeEmptyCommandsRoot(): Promise<void> {
    const exists = await this.files.verifyManagedPath(CLAUDE_COMMANDS_ROOT, {
      expectedType: 'folder',
      allowMissing: true,
    });
    if (exists && (await this.files.listManagedFolderEntries(CLAUDE_COMMANDS_ROOT)).length === 0) {
      await this.files.removeManagedFolderIfEmpty(CLAUDE_COMMANDS_ROOT);
    }
  }
}
