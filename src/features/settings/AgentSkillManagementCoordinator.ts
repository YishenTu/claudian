import type {
  AgentSkillDocument,
  AgentSkillInput,
  AgentSkillListResult,
  AgentSkillRepairDraft,
} from '../../core/skills/AgentSkill';
import type { AgentSkillRepository, SkillFrontmatterPolicy } from '../../core/skills/AgentSkillRepository';
import type {
  ClaudeCommandDocument,
  ClaudeCommandListResult,
  ClaudeCommandRepository,
} from '../../core/skills/ClaudeCommandRepository';

export interface AgentSkillMutationResult<T> {
  value: T;
  refreshFailed: boolean;
}

export type AgentSkillPanelRefresh = () => void | Promise<void>;
export type AgentSkillsChangedCallback = () => void | Promise<void>;

/** Manages one skills folder and, for Claude, the vault command files beside it. */
export class AgentSkillManagementCoordinator {
  private readonly panelRefreshers = new Set<AgentSkillPanelRefresh>();

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

  subscribe(refresh: AgentSkillPanelRefresh): () => void {
    this.panelRefreshers.add(refresh);
    return () => {
      this.panelRefreshers.delete(refresh);
    };
  }

  resetSubscriptions(): void {
    this.panelRefreshers.clear();
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

  /** Creates the skill first so a failed conversion never loses the command. */
  async convertCommand(
    command: ClaudeCommandDocument,
    input: AgentSkillInput,
  ): Promise<AgentSkillMutationResult<AgentSkillDocument>> {
    const commands = this.#requireCommands();
    const value = await this.repository.create(input, { frontmatter: command.frontmatter });
    await commands.trash(command.name, command.revision);
    return this.#completeMutation(value);
  }

  #requireCommands(): ClaudeCommandRepository {
    if (!this.commands) throw new Error('This skill folder does not manage commands');
    return this.commands;
  }

  async #completeMutation<T>(value: T): Promise<AgentSkillMutationResult<T>> {
    const refreshers = [...this.panelRefreshers];
    const [providerRefresh] = await Promise.all([
      Promise.resolve().then(() => this.notifyAgentSkillsChanged()).then(
        () => false,
        () => true,
      ),
      Promise.allSettled(refreshers.map(refresh => Promise.resolve().then(refresh))),
    ]);
    return { value, refreshFailed: providerRefresh };
  }
}
