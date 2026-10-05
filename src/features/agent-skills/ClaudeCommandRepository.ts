import { createHash } from 'node:crypto';
import * as path from 'node:path';

import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import type { AgentSkillDiagnostic, AgentSkillInput } from '@/features/agent-skills/AgentSkill';
import { serializeMarkdownWithFrontmatter } from '@/features/agent-skills/AgentSkillCodec';
import {
  AgentSkillRepositoryError,
  CLAUDE_COMMANDS_ROOT,
  type SkillFrontmatterPolicy,
} from '@/features/agent-skills/AgentSkillRepository';
import { parseFrontmatter } from '@/features/agent-skills/frontmatter';
import { AgentSkillValidationError, validateAgentSkillName } from '@/features/agent-skills/validateAgentSkill';

const COMMAND_EXTENSION = '.md';

export interface ClaudeCommandDocument {
  /** Path relative to `.claude/commands` without `.md`; nested commands keep `/`. */
  name: string;
  description: string;
  instructions: string;
  frontmatter: Record<string, unknown>;
  filePath: string;
  revision: string;
}

export interface ClaudeCommandListResult {
  commands: ClaudeCommandDocument[];
  diagnostics: AgentSkillDiagnostic[];
}

export interface ClaudeCommandRepositoryOptions {
  frontmatterPolicy?: SkillFrontmatterPolicy;
}

export class ClaudeCommandCollisionError extends AgentSkillRepositoryError {
  constructor(readonly commandName: string) {
    super(`A command named "${commandName}" already exists`);
    this.name = 'ClaudeCommandCollisionError';
  }
}

export class ClaudeCommandRevisionConflictError extends AgentSkillRepositoryError {
  constructor(readonly commandName: string) {
    super(`Command "${commandName}" changed since it was loaded`);
    this.name = 'ClaudeCommandRevisionConflictError';
  }
}

/** The command name for a file under `.claude/commands`, e.g. `git/commit`. */
export function commandNameFromPath(filePath: string): string {
  return filePath.slice(CLAUDE_COMMANDS_ROOT.length + 1, -COMMAND_EXTENSION.length);
}

/** The skill name a command converts to: nested segments joined by `-`, lowercased. */
export function commandSkillName(commandName: string): string {
  return commandName.replace(/\//g, '-').toLowerCase();
}

function digest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Parses a Claude command file; frontmatter is optional and malformed YAML falls back to the raw body. */
function parseClaudeCommandMarkdown(raw: string): {
  description: string;
  instructions: string;
  frontmatter: Record<string, unknown>;
} {
  const parsed = parseFrontmatter(raw);
  const frontmatter = parsed?.frontmatter ?? {};
  const body = parsed?.body ?? raw;
  return {
    description: typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '',
    instructions: body.replace(/\r\n/g, '\n').trim(),
    frontmatter,
  };
}

/** Manages vault-level Claude command files under `.claude/commands`. */
export class ClaudeCommandRepository {
  private mutationQueue: Promise<void> = Promise.resolve();
  readonly frontmatterPolicy: SkillFrontmatterPolicy;

  constructor(
    private readonly files: VaultFileAdapter,
    options: ClaudeCommandRepositoryOptions = {},
  ) {
    this.frontmatterPolicy = options.frontmatterPolicy ?? 'preserve';
  }

  async list(): Promise<ClaudeCommandListResult> {
    const rootExists = await this.files.verifyManagedPath(CLAUDE_COMMANDS_ROOT, {
      expectedType: 'folder',
      allowMissing: true,
    });
    if (!rootExists) return { commands: [], diagnostics: [] };

    const commands: ClaudeCommandDocument[] = [];
    const diagnostics: AgentSkillDiagnostic[] = [];
    for (const filePath of await this.#listCommandFiles(CLAUDE_COMMANDS_ROOT)) {
      try {
        commands.push(await this.#readDocument(filePath));
      } catch (error) {
        diagnostics.push({
          directoryPath: filePath,
          message: error instanceof Error ? error.message : 'Could not read command',
        });
      }
    }
    commands.sort((left, right) => left.name.localeCompare(right.name));
    return { commands, diagnostics };
  }

  async update(
    previousName: string,
    expectedRevision: string,
    input: AgentSkillInput,
  ): Promise<ClaudeCommandDocument> {
    if (input.name !== previousName) this.#assertValidName(input.name);
    if (!input.instructions.trim()) {
      throw new AgentSkillValidationError('instructions', 'Command instructions are required');
    }
    return this.#withMutation(async () => {
      const current = await this.#readDocument(this.#filePath(previousName));
      if (current.revision !== expectedRevision) {
        throw new ClaudeCommandRevisionConflictError(previousName);
      }
      const content = this.#serialize(current.frontmatter, input);
      if (input.name === previousName) {
        await this.files.writeManagedFile(current.filePath, content);
        return this.#documentFromRaw(current.filePath, content);
      }

      const targetPath = this.#filePath(input.name);
      if (await this.#exists(targetPath)) throw new ClaudeCommandCollisionError(input.name);
      await this.files.ensureManagedFolder(path.posix.dirname(targetPath));
      await this.files.writeManagedFile(targetPath, content);
      await this.files.removeManagedFile(current.filePath);
      await this.#pruneEmptyFolders(path.posix.dirname(current.filePath));
      return this.#documentFromRaw(targetPath, content);
    });
  }

  /** Throws a revision conflict when the command changed since `expectedRevision` was read. */
  async assertRevision(name: string, expectedRevision: string): Promise<void> {
    const current = await this.#readDocument(this.#filePath(name));
    if (current.revision !== expectedRevision) {
      throw new ClaudeCommandRevisionConflictError(name);
    }
  }

  async trash(name: string, expectedRevision: string): Promise<void> {
    await this.#withMutation(async () => {
      const current = await this.#readDocument(this.#filePath(name));
      if (current.revision !== expectedRevision) {
        throw new ClaudeCommandRevisionConflictError(name);
      }
      await this.files.trash(current.filePath);
      await this.#pruneEmptyFolders(path.posix.dirname(current.filePath));
    });
  }

  #serialize(currentFrontmatter: Record<string, unknown>, input: AgentSkillInput): string {
    const frontmatter: Record<string, unknown> = this.frontmatterPolicy === 'preserve'
      ? { ...currentFrontmatter }
      : {};
    const description = input.description.trim();
    if (description) {
      frontmatter.description = description;
    } else {
      delete frontmatter.description;
    }
    return serializeMarkdownWithFrontmatter(frontmatter, input.instructions.trim());
  }

  #assertValidName(name: string): void {
    for (const segment of name.split('/')) {
      const error = validateAgentSkillName(segment);
      if (error) throw new AgentSkillValidationError('name', error.replace('Skill name', 'Command name'));
    }
  }

  #filePath(name: string): string {
    const segments = name.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\'))) {
      throw new AgentSkillValidationError('name', 'Command name must be a relative path');
    }
    return `${CLAUDE_COMMANDS_ROOT}/${name}${COMMAND_EXTENSION}`;
  }

  async #listCommandFiles(folder: string): Promise<string[]> {
    const listing = await this.files.listManagedFolder(folder);
    const nested = await Promise.all(
      listing.folders
        .filter(child => path.posix.dirname(child) === folder)
        .map(child => this.#listCommandFiles(child)),
    );
    return [
      ...listing.files.filter(file => path.posix.dirname(file) === folder && file.endsWith(COMMAND_EXTENSION)),
      ...nested.flat(),
    ];
  }

  async #exists(filePath: string): Promise<boolean> {
    try {
      return await this.files.verifyManagedPath(filePath, { expectedType: 'file', allowMissing: true });
    } catch {
      return true;
    }
  }

  /**
   * Runs after the command file is already moved or trashed, so it is
   * best-effort: a folder that can't be removed must not report the committed
   * change as failed.
   */
  async #pruneEmptyFolders(folder: string): Promise<void> {
    let current = folder;
    try {
      while (current !== CLAUDE_COMMANDS_ROOT && current.startsWith(`${CLAUDE_COMMANDS_ROOT}/`)) {
        const listing = await this.files.listManagedFolder(current);
        if (listing.files.length > 0 || listing.folders.length > 0) return;
        await this.files.removeManagedFolderIfEmpty(current);
        current = path.posix.dirname(current);
      }
    } catch {
      // An empty folder left behind is harmless; commands are only read from files.
    }
  }

  async #readDocument(filePath: string): Promise<ClaudeCommandDocument> {
    const raw = await this.files.readManagedFile(filePath);
    return this.#documentFromRaw(filePath, raw);
  }

  #documentFromRaw(filePath: string, raw: string): ClaudeCommandDocument {
    return {
      ...parseClaudeCommandMarkdown(raw),
      name: commandNameFromPath(filePath),
      filePath,
      revision: digest(raw),
    };
  }

  #withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
