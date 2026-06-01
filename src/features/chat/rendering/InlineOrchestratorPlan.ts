import type { OrchestratorPlan, OrchestratorTask } from './orchestratorPlanParser';

export class InlineOrchestratorPlan {
  private containerEl: HTMLElement;
  private plan: OrchestratorPlan;
  private onApprove: (tasks: OrchestratorTask[]) => void;
  private onCancel: () => void;

  constructor(
    containerEl: HTMLElement,
    plan: OrchestratorPlan,
    onApprove: (tasks: OrchestratorTask[]) => void,
    onCancel: () => void,
  ) {
    this.containerEl = containerEl;
    this.plan = plan;
    this.onApprove = onApprove;
    this.onCancel = onCancel;
  }

  render(): void {
    const rootEl = this.containerEl.createDiv({ cls: 'claudian-orchestrator-plan' });

    const count = this.plan.tasks.length;
    rootEl
      .createDiv({ cls: 'claudian-orchestrator-plan-header' })
      .createEl('h4', { text: `Spawn ${count} worker${count !== 1 ? 's' : ''}?` });

    const listEl = rootEl.createEl('ul', { cls: 'claudian-orchestrator-plan-tasks' });
    for (const task of this.plan.tasks) {
      listEl.createEl('li', { cls: 'claudian-orchestrator-plan-task' })
            .createEl('strong', { text: task.description });
    }

    const actionsEl = rootEl.createDiv({ cls: 'claudian-orchestrator-plan-actions' });

    const approveBtn = actionsEl.createEl('button', {
      cls: 'claudian-orchestrator-plan-approve mod-cta',
      text: 'Spawn Workers',
    });
    const cancelBtn = actionsEl.createEl('button', {
      cls: 'claudian-orchestrator-plan-cancel',
      text: 'Cancel',
    });

    const disable = () => {
      approveBtn.disabled = true;
      cancelBtn.disabled = true;
    };

    approveBtn.addEventListener('click', () => {
      disable();
      this.onApprove(this.plan.tasks);
    });

    cancelBtn.addEventListener('click', () => {
      disable();
      this.onCancel();
    });
  }
}
