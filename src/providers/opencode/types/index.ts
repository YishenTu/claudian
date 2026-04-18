export interface OpencodeSkill {
  name: string;
  description: string;
  content: string;
  path: string;
  scope: 'user' | 'repo' | 'system';
}

export interface OpencodeSkillMetadata {
  name: string;
  description: string;
  path: string;
  scope: 'user' | 'repo' | 'system';
  enabled: boolean;
}
