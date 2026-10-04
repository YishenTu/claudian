import { createHash } from 'node:crypto';
import * as path from 'node:path';

import {
  ManagedResourceCollisionError,
  ManagedResourceRelocationError,
  type VaultFileAdapter,
} from '@/core/storage/VaultFileAdapter';
import { mapWithConcurrency } from '@/utils/concurrency';

import type {
  AgentSkillDocument,
  AgentSkillInput,
  AgentSkillListResult,
  AgentSkillRepairDraft,
} from './AgentSkill';
import {
  AgentSkillCodecError,
  parseAgentSkillMarkdown,
  parseLenientAgentSkillMarkdown,
  serializeAgentSkillMarkdown,
} from './AgentSkillCodec';
import { AgentSkillValidationError, validateAgentSkillInput, validateAgentSkillName } from './validateAgentSkill';

export const AGENT_SKILLS_ROOT = '.agents/skills';
export const CLAUDE_SKILLS_ROOT = '.claude/skills';
export const CLAUDE_COMMANDS_ROOT = '.claude/commands';
const SKILL_FILENAME = 'SKILL.md';

/** `preserve` keeps frontmatter the panel does not edit; `portable` writes only name and description. */
export type SkillFrontmatterPolicy = 'preserve' | 'portable';
/** `lenient` lists legacy packages by folder name even when their frontmatter is incomplete. */
export type SkillReadPolicy = 'strict' | 'lenient';

export interface AgentSkillRepositoryOptions {
  root?: string;
  frontmatterPolicy?: SkillFrontmatterPolicy;
  readPolicy?: SkillReadPolicy;
}

export class AgentSkillRepositoryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentSkillRepositoryError';
  }
}

export class AgentSkillCollisionError extends AgentSkillRepositoryError {
  constructor(readonly skillName: string, options?: ErrorOptions) {
    super(`A skill package named "${skillName}" already exists`, options);
    this.name = 'AgentSkillCollisionError';
  }
}

export class AgentSkillRevisionConflictError extends AgentSkillRepositoryError {
  constructor(readonly skillName: string) {
    super(`Skill "${skillName}" changed since it was loaded`);
    this.name = 'AgentSkillRevisionConflictError';
  }
}

export class AgentSkillRollbackError extends AgentSkillRepositoryError {
  readonly rollbackErrors: readonly Error[];

  constructor(message: string, cause: unknown, rollbackErrors: Error[]) {
    super(message, { cause });
    this.name = 'AgentSkillRollbackError';
    this.rollbackErrors = rollbackErrors;
  }
}

function digest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class AgentSkillRepository {
  private mutationQueue: Promise<void> = Promise.resolve();
  readonly root: string;
  readonly frontmatterPolicy: SkillFrontmatterPolicy;
  private readonly readPolicy: SkillReadPolicy;

  constructor(private readonly files: VaultFileAdapter, options: AgentSkillRepositoryOptions = {}) {
    this.root = options.root ?? AGENT_SKILLS_ROOT;
    this.frontmatterPolicy = options.frontmatterPolicy ?? 'preserve';
    this.readPolicy = options.readPolicy ?? 'strict';
  }

  async list(): Promise<AgentSkillListResult> {
    const rootExists = await this.files.verifyManagedPath(this.root, {
      expectedType: 'folder',
      allowMissing: true,
    });
    if (!rootExists) return { skills: [], diagnostics: [] };

    // Links are listed too (and reported as diagnostics) so a dangling one cannot hide every skill.
    const directPackages = (await this.files.listManagedFolderEntries(this.root))
      .filter(entry => (entry.type === 'folder' || entry.type === 'link')
        && path.posix.dirname(entry.path) === this.root)
      .map(entry => entry.path)
      .sort((left, right) => left.localeCompare(right));
    const skills: AgentSkillDocument[] = [];
    const diagnostics: AgentSkillListResult['diagnostics'] = [];

    await mapWithConcurrency(directPackages, async directoryPath => {
      const name = path.posix.basename(directoryPath);
      try {
        const document = await this.#readDocument(name);
        skills.push(document);
      } catch (error) {
        diagnostics.push({
          directoryPath,
          message: error instanceof Error ? error.message : 'Could not read skill package',
          ...(await this.#isRepairable(name) ? { repairName: name } : {}),
        });
      }
    }, 8);

    skills.sort((left, right) => left.name.localeCompare(right.name));
    diagnostics.sort((left, right) => (
      left.directoryPath.localeCompare(right.directoryPath)
      || left.message.localeCompare(right.message)
    ));
    return { skills, diagnostics };
  }

  /**
   * `frontmatter` seeds extra keys (for example from a converted command) and
   * is ignored under the portable policy.
   */
  async create(
    input: AgentSkillInput,
    options: { frontmatter?: Record<string, unknown> } = {},
  ): Promise<AgentSkillDocument> {
    validateAgentSkillInput(input);
    return this.#withMutation(async () => {
      await this.files.ensureManagedFolder(this.root);
      const directory = this.#packagePath(input.name);
      try {
        await this.files.createManagedFolderExclusive(directory);
      } catch (error) {
        if (error instanceof ManagedResourceCollisionError) {
          throw new AgentSkillCollisionError(input.name, { cause: error });
        }
        throw error;
      }

      const filePath = this.#skillFilePath(input.name);
      const baseFrontmatter = this.frontmatterPolicy === 'preserve' ? options.frontmatter ?? {} : {};
      const content = serializeAgentSkillMarkdown(baseFrontmatter, input);
      try {
        await this.files.writeManagedFile(filePath, content);
      } catch (error) {
        const rollbackErrors: Error[] = [];
        try {
          await this.files.removeManagedFile(filePath);
        } catch (rollbackError) {
          rollbackErrors.push(toError(rollbackError));
        }
        try {
          await this.files.removeManagedFolderIfEmpty(directory);
        } catch (rollbackError) {
          rollbackErrors.push(toError(rollbackError));
        }
        if (rollbackErrors.length > 0) {
          throw new AgentSkillRollbackError(
            `Could not create skill "${input.name}" and rollback was incomplete`,
            error,
            rollbackErrors,
          );
        }
        throw error;
      }
      return this.#documentFromRaw(input.name, content);
    });
  }

  async update(
    previousName: string,
    expectedRevision: string,
    input: AgentSkillInput,
  ): Promise<AgentSkillDocument> {
    this.#assertValidName(previousName);
    validateAgentSkillInput(input);
    return this.#withMutation(async () => {
      const current = await this.#readDocumentWithRaw(previousName);
      if (current.skill.revision !== expectedRevision) {
        throw new AgentSkillRevisionConflictError(previousName);
      }
      const baseFrontmatter = this.frontmatterPolicy === 'preserve' ? current.skill.frontmatter : {};
      const content = serializeAgentSkillMarkdown(baseFrontmatter, input);
      return this.#writePackage(previousName, input.name, content);
    });
  }

  /**
   * Reads a package whose SKILL.md has frontmatter but fails validation (for
   * example a missing description or an invalid name), for fixing in the editor.
   * Anything more broken is left to the user.
   */
  async readForRepair(name: string): Promise<AgentSkillRepairDraft> {
    this.#assertSafeSegment(name);
    await this.files.verifyManagedPath(this.#packagePath(name), { expectedType: 'folder' });
    const raw = await this.files.readManagedFile(this.#skillFilePath(name));
    let parsed;
    try {
      parsed = parseLenientAgentSkillMarkdown(raw, name);
    } catch (error) {
      if (!(error instanceof AgentSkillCodecError)) throw error;
      throw new AgentSkillRepositoryError(`Skill "${name}" cannot be repaired here: ${error.message}`, { cause: error });
    }
    return {
      input: { name, description: parsed.description, instructions: parsed.instructions },
      frontmatter: parsed.frontmatter,
      revision: digest(raw),
    };
  }

  /** Rewrites a broken package as a valid skill, renaming its folder when the name changes. */
  async repair(
    name: string,
    expectedRevision: string,
    input: AgentSkillInput,
  ): Promise<AgentSkillDocument> {
    this.#assertSafeSegment(name);
    validateAgentSkillInput(input);
    return this.#withMutation(async () => {
      const current = await this.readForRepair(name);
      if (current.revision !== expectedRevision) {
        throw new AgentSkillRevisionConflictError(name);
      }
      const baseFrontmatter = this.frontmatterPolicy === 'preserve' ? current.frontmatter : {};
      return this.#writePackage(name, input.name, serializeAgentSkillMarkdown(baseFrontmatter, input));
    });
  }

  async trashBroken(name: string): Promise<void> {
    this.#assertSafeSegment(name);
    await this.#withMutation(async () => {
      const directory = this.#packagePath(name);
      await this.files.verifyManagedPath(directory, { expectedType: 'folder' });
      await this.files.trash(directory);
    });
  }

  /**
   * Writes SKILL.md for `previousName`, renaming the package to `name` first when
   * they differ. Managed writes are atomic, so a failed write leaves the previous
   * SKILL.md in place and only the rename needs undoing.
   */
  async #writePackage(previousName: string, name: string, content: string): Promise<AgentSkillDocument> {
    if (previousName === name) {
      await this.files.writeManagedFile(this.#skillFilePath(name), content);
      return this.#documentFromRaw(name, content);
    }

    const oldDirectory = this.#packagePath(previousName);
    const newDirectory = this.#packagePath(name);
    try {
      await this.files.relocateManagedPackageNoReplace(oldDirectory, newDirectory);
    } catch (error) {
      const collision = error instanceof ManagedResourceCollisionError
        || (
          error instanceof ManagedResourceRelocationError
          && error.cause instanceof ManagedResourceCollisionError
          && error.rollbackErrors.length === 0
        );
      if (collision) {
        throw new AgentSkillCollisionError(name, { cause: error });
      }
      throw error;
    }

    try {
      await this.files.writeManagedFile(this.#skillFilePath(name), content);
    } catch (error) {
      try {
        await this.files.relocateManagedPackageNoReplace(newDirectory, oldDirectory);
      } catch (rollbackError) {
        throw new AgentSkillRollbackError(
          `Could not rename skill "${previousName}" and rollback was incomplete`,
          error,
          [toError(rollbackError)],
        );
      }
      throw error;
    }
    return this.#documentFromRaw(name, content);
  }

  async trash(name: string, expectedRevision: string): Promise<void> {
    this.#assertValidName(name);
    await this.#withMutation(async () => {
      const current = await this.#readDocument(name);
      if (current.revision !== expectedRevision) {
        throw new AgentSkillRevisionConflictError(name);
      }
      const directory = this.#packagePath(name);
      await this.files.verifyManagedPath(directory, { expectedType: 'folder' });
      await this.files.trash(directory);
    });
  }

  #assertValidName(name: string): void {
    if (this.readPolicy === 'lenient') {
      this.#assertSafeSegment(name);
      return;
    }
    const error = validateAgentSkillName(name);
    if (error) throw new AgentSkillValidationError('name', error);
  }

  #assertSafeSegment(name: string): void {
    if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) {
      throw new AgentSkillValidationError('name', 'Skill folder name is not a single path segment');
    }
  }

  async #isRepairable(name: string): Promise<boolean> {
    try {
      await this.readForRepair(name);
      return true;
    } catch {
      return false;
    }
  }

  #packagePath(name: string): string {
    return `${this.root}/${name}`;
  }

  #skillFilePath(name: string): string {
    return `${this.#packagePath(name)}/${SKILL_FILENAME}`;
  }

  async #readDocument(name: string): Promise<AgentSkillDocument> {
    return (await this.#readDocumentWithRaw(name)).skill;
  }

  async #readDocumentWithRaw(name: string): Promise<{
    skill: AgentSkillDocument;
    raw: string;
  }> {
    this.#assertValidName(name);
    const filePath = this.#skillFilePath(name);
    // The safe reader validates the file and every ancestor immediately before reading.
    const raw = await this.files.readManagedFile(filePath);
    return { skill: this.#documentFromRaw(name, raw), raw };
  }

  #documentFromRaw(name: string, raw: string): AgentSkillDocument {
    let parsed;
    try {
      parsed = this.readPolicy === 'lenient'
        ? parseLenientAgentSkillMarkdown(raw, name)
        : parseAgentSkillMarkdown(raw, name);
    } catch (error) {
      if (error instanceof AgentSkillCodecError) throw error;
      throw new AgentSkillCodecError('Could not parse SKILL.md', { cause: error });
    }
    return {
      ...parsed,
      directoryPath: this.#packagePath(name),
      filePath: this.#skillFilePath(name),
      revision: digest(raw),
    };
  }

  #withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
