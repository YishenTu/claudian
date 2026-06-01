export interface OrchestratorTask {
  id: string;
  description: string;
  prompt: string;
}

export interface OrchestratorPlan {
  type: 'orchestrator_plan';
  tasks: OrchestratorTask[];
}

const PLAN_BLOCK_RE = /```(?:json)?\s*\n([\s\S]*?)\n```/g;

export function extractOrchestratorPlan(text: string): OrchestratorPlan | null {
  PLAN_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLAN_BLOCK_RE.exec(text)) !== null) {
    const plan = tryParsePlan(match[1]);
    if (plan) return plan;
  }
  return null;
}

function tryParsePlan(json: string): OrchestratorPlan | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return isValidPlan(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isValidPlan(value: unknown): value is OrchestratorPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (obj['type'] !== 'orchestrator_plan') return false;
  if (!Array.isArray(obj['tasks']) || obj['tasks'].length === 0) return false;
  return (obj['tasks'] as unknown[]).every(isValidTask);
}

function isValidTask(value: unknown): value is OrchestratorTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj['id'] === 'string' &&
    typeof obj['description'] === 'string' &&
    typeof obj['prompt'] === 'string'
  );
}
