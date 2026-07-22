import { createHash } from 'node:crypto';
import * as path from 'node:path';

import {
  ManagedResourceCollisionError,
  ManagedResourceRelocationError,
  type VaultFileAdapter,
} from '../storage/VaultFileAdapter';
import type {
  AgentSkillDocument,
  AgentSkillInput,
  AgentSkillListResult,
} from './AgentSkill';
import {
  AgentSkillCodecError,
  parseAgentSkillMarkdown,
  serializeAgentSkillMarkdown,
} from './AgentSkillCodec';
import { AgentSkillValidationError, validateAgentSkillInput, validateAgentSkillName } from './validateAgentSkill';

export const AGENT_SKILLS_ROOT = '.agents/skills';
const SKILL_FILENAME = 'SKILL.md';

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

function packagePath(name: string): string {
  return `${AGENT_SKILLS_ROOT}/${name}`;
}

function skillFilePath(name: string): string {
  return `${packagePath(name)}/${SKILL_FILENAME}`;
}

export class AgentSkillRepository {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly files: VaultFileAdapter) {}

  async list(): Promise<AgentSkillListResult> {
    const agentsExists = await this.files.verifyManagedPath('.agents', {
      expectedType: 'folder',
      allowMissing: true,
    });
    if (!agentsExists) return { skills: [], diagnostics: [] };

    const rootExists = await this.files.verifyManagedPath(AGENT_SKILLS_ROOT, {
      expectedType: 'folder',
      allowMissing: true,
    });
    if (!rootExists) return { skills: [], diagnostics: [] };

    const listing = await this.files.listManagedFolder(AGENT_SKILLS_ROOT);
    const directPackages = listing.folders
      .filter(folder => path.posix.dirname(folder) === AGENT_SKILLS_ROOT)
      .sort((left, right) => left.localeCompare(right));
    const skills: AgentSkillDocument[] = [];
    const diagnostics: AgentSkillListResult['diagnostics'] = [];

    for (const directoryPath of directPackages) {
      const name = path.posix.basename(directoryPath);
      try {
        const document = await this.readDocument(name);
        skills.push(document);
      } catch (error) {
        diagnostics.push({
          directoryPath,
          message: error instanceof Error ? error.message : 'Could not read skill package',
        });
      }
    }

    skills.sort((left, right) => left.name.localeCompare(right.name));
    diagnostics.sort((left, right) => (
      left.directoryPath.localeCompare(right.directoryPath)
      || left.message.localeCompare(right.message)
    ));
    return { skills, diagnostics };
  }

  async create(input: AgentSkillInput): Promise<AgentSkillDocument> {
    validateAgentSkillInput(input);
    return this.withMutation(async () => {
      await this.files.ensureManagedFolder(AGENT_SKILLS_ROOT);
      const directory = packagePath(input.name);
      try {
        await this.files.createManagedFolderExclusive(directory);
      } catch (error) {
        if (error instanceof ManagedResourceCollisionError) {
          throw new AgentSkillCollisionError(input.name, { cause: error });
        }
        throw error;
      }

      const filePath = skillFilePath(input.name);
      const content = serializeAgentSkillMarkdown({}, input);
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
      return this.documentFromRaw(input.name, content);
    });
  }

  async update(
    previousName: string,
    expectedRevision: string,
    input: AgentSkillInput,
  ): Promise<AgentSkillDocument> {
    this.assertValidName(previousName);
    validateAgentSkillInput(input);
    return this.withMutation(async () => {
      const current = await this.readDocumentWithRaw(previousName);
      if (current.skill.revision !== expectedRevision) {
        throw new AgentSkillRevisionConflictError(previousName);
      }
      const content = serializeAgentSkillMarkdown(current.skill.frontmatter, input);
      if (previousName === input.name) {
        await this.files.writeManagedFile(current.skill.filePath, content);
        return this.documentFromRaw(input.name, content);
      }

      const oldDirectory = packagePath(previousName);
      const newDirectory = packagePath(input.name);
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
          throw new AgentSkillCollisionError(input.name, { cause: error });
        }
        throw error;
      }

      const newFilePath = skillFilePath(input.name);
      try {
        await this.files.writeManagedFile(newFilePath, content);
      } catch (error) {
        const rollbackErrors: Error[] = [];
        try {
          await this.files.writeManagedFile(newFilePath, current.raw);
        } catch (rollbackError) {
          rollbackErrors.push(toError(rollbackError));
        }
        try {
          await this.files.relocateManagedPackageNoReplace(newDirectory, oldDirectory);
        } catch (rollbackError) {
          rollbackErrors.push(toError(rollbackError));
        }
        if (rollbackErrors.length > 0) {
          throw new AgentSkillRollbackError(
            `Could not rename skill "${previousName}" and rollback was incomplete`,
            error,
            rollbackErrors,
          );
        }
        throw error;
      }
      return this.documentFromRaw(input.name, content);
    });
  }

  async trash(name: string, expectedRevision: string): Promise<void> {
    this.assertValidName(name);
    await this.withMutation(async () => {
      const current = await this.readDocument(name);
      if (current.revision !== expectedRevision) {
        throw new AgentSkillRevisionConflictError(name);
      }
      const directory = packagePath(name);
      await this.files.verifyManagedPath(directory, { expectedType: 'folder' });
      await this.files.trash(directory);
    });
  }

  private assertValidName(name: string): void {
    const error = validateAgentSkillName(name);
    if (error) throw new AgentSkillValidationError('name', error);
  }

  private async readDocument(name: string): Promise<AgentSkillDocument> {
    return (await this.readDocumentWithRaw(name)).skill;
  }

  private async readDocumentWithRaw(name: string): Promise<{
    skill: AgentSkillDocument;
    raw: string;
  }> {
    this.assertValidName(name);
    const directoryPath = packagePath(name);
    const filePath = skillFilePath(name);
    await this.files.verifyManagedPath(directoryPath, { expectedType: 'folder' });
    await this.files.verifyManagedPath(filePath, { expectedType: 'file' });
    const raw = await this.files.readManagedFile(filePath);
    return { skill: this.documentFromRaw(name, raw), raw };
  }

  private documentFromRaw(name: string, raw: string): AgentSkillDocument {
    let parsed;
    try {
      parsed = parseAgentSkillMarkdown(raw, name);
    } catch (error) {
      if (error instanceof AgentSkillCodecError) throw error;
      throw new AgentSkillCodecError('Could not parse SKILL.md', { cause: error });
    }
    return {
      ...parsed,
      directoryPath: packagePath(name),
      filePath: skillFilePath(name),
      revision: digest(raw),
    };
  }

  private withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
