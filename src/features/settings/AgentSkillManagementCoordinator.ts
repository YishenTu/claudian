import type {
  AgentSkillDocument,
  AgentSkillInput,
  AgentSkillListResult,
} from '../../core/skills/AgentSkill';
import type { AgentSkillRepository } from '../../core/skills/AgentSkillRepository';

export interface AgentSkillMutationResult<T> {
  value: T;
  refreshFailed: boolean;
}

export type AgentSkillPanelRefresh = () => void | Promise<void>;
export type AgentSkillsChangedCallback = () => void | Promise<void>;

export class AgentSkillManagementCoordinator {
  private readonly panelRefreshers = new Set<AgentSkillPanelRefresh>();

  constructor(
    private readonly repository: AgentSkillRepository,
    private readonly notifyAgentSkillsChanged: AgentSkillsChangedCallback,
  ) {}

  list(): Promise<AgentSkillListResult> {
    return this.repository.list();
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
    return this.completeMutation(value);
  }

  async update(
    previousName: string,
    expectedRevision: string,
    input: AgentSkillInput,
  ): Promise<AgentSkillMutationResult<AgentSkillDocument>> {
    const value = await this.repository.update(previousName, expectedRevision, input);
    return this.completeMutation(value);
  }

  async trash(
    name: string,
    expectedRevision: string,
  ): Promise<AgentSkillMutationResult<void>> {
    await this.repository.trash(name, expectedRevision);
    return this.completeMutation(undefined);
  }

  private async completeMutation<T>(value: T): Promise<AgentSkillMutationResult<T>> {
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
