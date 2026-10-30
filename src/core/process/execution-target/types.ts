import type { InstallationMethod } from '@/core/providers/settings/InstallationSettings';

export type ExecutionMethod = 'host-native' | InstallationMethod;
export type ExecutionPlatformOs = 'windows' | 'linux' | 'macos';
export type ExecutionPlatformFamily = 'windows' | 'unix';

export interface ExecutionTarget {
  method: ExecutionMethod;
  platformFamily: ExecutionPlatformFamily;
  platformOs: ExecutionPlatformOs;
  distroName?: string;
}

export interface ExecutionPathMapper {
  target: ExecutionTarget;
  toTargetPath(hostPath: string): string | null;
  toHostPath(targetPath: string): string | null;
  mapTargetPathList(hostPaths: string[]): string[];
  canRepresentHostPath(hostPath: string): boolean;
}

export interface TargetLaunchSpec {
  target: ExecutionTarget;
  command: string;
  args: string[];
  spawnCwd: string;
  targetCwd: string;
  windowsVerbatimArguments?: boolean;
  env: Record<string, string>;
  pathMapper: ExecutionPathMapper;
}
