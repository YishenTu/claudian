export type SkillRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'needs_attention'
  | 'cancelled';

export interface SkillRun {
  id: string;
  conversationId: string;
  skillName: string;
  args: string;
  workingDirectory?: string;
  status: SkillRunStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  sessionId?: string | null;
  summary?: string;
  lastLogLine?: string;
  log?: string;
  error?: string;
  attentionReason?: string;
}
