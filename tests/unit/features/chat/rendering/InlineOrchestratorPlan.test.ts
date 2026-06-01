/** @jest-environment jsdom */

import { createMockEl } from '@test/helpers/mockElement';

import { InlineOrchestratorPlan } from '@/features/chat/rendering/InlineOrchestratorPlan';
import type { OrchestratorPlan } from '@/features/chat/rendering/orchestratorPlanParser';

const PLAN: OrchestratorPlan = {
  type: 'orchestrator_plan',
  tasks: [
    { id: '1', description: 'Research', prompt: 'Search for X.' },
    { id: '2', description: 'Write', prompt: 'Write about X.' },
  ],
};

describe('InlineOrchestratorPlan', () => {
  it('renders a task row for each task', () => {
    const container = createMockEl();
    new InlineOrchestratorPlan(container, PLAN, jest.fn(), jest.fn()).render();
    const items = container.querySelectorAll('.claudian-orchestrator-plan-task');
    expect(items).toHaveLength(2);
  });

  it('calls onApprove with the plan tasks when Spawn Workers is clicked', () => {
    const container = createMockEl();
    const onApprove = jest.fn();
    new InlineOrchestratorPlan(container, PLAN, onApprove, jest.fn()).render();
    const btn = container.querySelector('.claudian-orchestrator-plan-approve') as any;
    btn.click();
    expect(onApprove).toHaveBeenCalledWith(PLAN.tasks);
  });

  it('does not call onApprove when Cancel is clicked', () => {
    const container = createMockEl();
    const onApprove = jest.fn();
    const onCancel = jest.fn();
    new InlineOrchestratorPlan(container, PLAN, onApprove, onCancel).render();
    const btn = container.querySelector('.claudian-orchestrator-plan-cancel') as any;
    btn.click();
    expect(onApprove).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it('disables both buttons after Approve is clicked', () => {
    const container = createMockEl();
    new InlineOrchestratorPlan(container, PLAN, jest.fn(), jest.fn()).render();
    const approve = container.querySelector('.claudian-orchestrator-plan-approve') as any;
    const cancel = container.querySelector('.claudian-orchestrator-plan-cancel') as any;
    approve.click();
    expect(approve.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);
  });
});
