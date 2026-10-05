import type {
  AgentSkillDocument,
  AgentSkillInput,
  AgentSkillListResult,
  AgentSkillRepairDraft,
} from '@/features/agent-skills/AgentSkill';
import type { AgentSkillRepository, SkillFrontmatterPolicy } from '@/features/agent-skills/AgentSkillRepository';
import type {
  ClaudeCommandDocument,
  ClaudeCommandListResult,
  ClaudeCommandRepository,
} from '@/features/agent-skills/ClaudeCommandRepository';

export interface AgentSkillMutationResult<T> {
  value: T;
  refreshFailed: boolean;
}

export type AgentSkillsChangedCallback = () => void | Promise<void>;

/**
 * Manages one skills folder and, for Claude, the vault command files beside it.
 * Every successful mutation invalidates provider skill resources.
 */
export class AgentSkillManagementCoordinator {
  constructor(
    private readonly repository: AgentSkillRepository,
    private readonly notifyAgentSkillsChanged: AgentSkillsChangedCallback,
    private readonly commands: ClaudeCommandRepository | null = null,
  ) {}

  get root(): string {
    return this.repository.root;
  }

  get frontmatterPolicy(): SkillFrontmatterPolicy {
    return this.repository.frontmatterPolicy;
  }

  get managesCommands(): boolean {
    return this.commands !== null;
  }

  list(): Promise<AgentSkillListResult> {
    return this.repository.list();
  }

  async listCommands(): Promise<ClaudeCommandListResult> {
    return this.commands ? this.commands.list() : { commands: [], diagnostics: [] };
  }

  async create(input: AgentSkillInput): Promise<AgentSkillMutationResult<AgentSkillDocument>> {
    const value = await this.repository.create(input);
    return this.#completeMutation(value);
  }

  async update(
    previousName: string,
    expectedRevision: string,
    input: AgentSkillInput,
  ): Promise<AgentSkillMutationResult<AgentSkillDocument>> {
    const value = await this.repository.update(previousName, expectedRevision, input);
    return this.#completeMutation(value);
  }

  async trash(
    name: string,
    expectedRevision: string,
  ): Promise<AgentSkillMutationResult<void>> {
    await this.repository.trash(name, expectedRevision);
    return this.#completeMutation(undefined);
  }

  readForRepair(name: string): Promise<AgentSkillRepairDraft> {
    return this.repository.readForRepair(name);
  }

  async repair(
    name: string,
    expectedRevision: string,
    input: AgentSkillInput,
  ): Promise<AgentSkillMutationResult<AgentSkillDocument>> {
    const value = await this.repository.repair(name, expectedRevision, input);
    return this.#completeMutation(value);
  }

  async trashBroken(name: string): Promise<AgentSkillMutationResult<void>> {
    await this.repository.trashBroken(name);
    return this.#completeMutation(undefined);
  }

  async updateCommand(
    command: ClaudeCommandDocument,
    input: AgentSkillInput,
  ): Promise<AgentSkillMutationResult<ClaudeCommandDocument>> {
    const value = await this.#requireCommands().update(command.name, command.revision, input);
    return this.#completeMutation(value);
  }

  async trashCommand(command: ClaudeCommandDocument): Promise<AgentSkillMutationResult<void>> {
    await this.#requireCommands().trash(command.name, command.revision);
    return this.#completeMutation(undefined);
  }

  /**
   * Checks the command is unchanged, creates the skill, then trashes the command.
   * If the command cannot be removed, the new skill is trashed so the command
   * stays the only copy and a retry does not collide.
   */
  async convertCommand(
    command: ClaudeCommandDocument,
    input: AgentSkillInput,
  ): Promise<AgentSkillMutationResult<AgentSkillDocument>> {
    const commands = this.#requireCommands();
    await commands.assertRevision(command.name, command.revision);
    const value = await this.repository.create(input, { frontmatter: command.frontmatter });
    try {
      await commands.trash(command.name, command.revision);
    } catch (error) {
      try {
        await this.repository.trash(value.name, value.revision);
      } catch (rollbackError) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; the new skill "${value.name}" could not be removed`,
          { cause: rollbackError },
        );
      }
      throw error;
    }
    return this.#completeMutation(value);
  }

  #requireCommands(): ClaudeCommandRepository {
    if (!this.commands) throw new Error('This skill folder does not manage commands');
    return this.commands;
  }

  async #completeMutation<T>(value: T): Promise<AgentSkillMutationResult<T>> {
    try {
      await this.notifyAgentSkillsChanged();
      return { value, refreshFailed: false };
    } catch {
      return { value, refreshFailed: true };
    }
  }
}
