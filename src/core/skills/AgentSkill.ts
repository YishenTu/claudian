export interface AgentSkillDocument {
  name: string;
  description: string;
  instructions: string;
  frontmatter: Record<string, unknown>;
  directoryPath: string;
  filePath: string;
  revision: string;
}

export interface AgentSkillInput {
  name: string;
  description: string;
  instructions: string;
}

export interface AgentSkillDiagnostic {
  directoryPath: string;
  message: string;
  /** Set when the package folder is safe to rewrite from the editor or move to trash. */
  repairName?: string;
}

/** Best-effort editor values for a package that does not parse as a valid skill. */
export interface AgentSkillRepairDraft {
  input: AgentSkillInput;
  frontmatter: Record<string, unknown>;
  /** Digest of the current SKILL.md. */
  revision: string;
}

export interface AgentSkillListResult {
  skills: AgentSkillDocument[];
  diagnostics: AgentSkillDiagnostic[];
}
