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
}

export interface AgentSkillListResult {
  skills: AgentSkillDocument[];
  diagnostics: AgentSkillDiagnostic[];
}
