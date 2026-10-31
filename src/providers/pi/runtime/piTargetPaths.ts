import * as path from 'node:path';

import { resolveExecutionTargetAsync } from '@/core/process/execution-target/ExecutionTargetResolver';
import type { ExecutionTarget } from '@/core/process/execution-target/types';
import { createExecutionPathMapper } from '@/core/process/execution-target/WSLPathMapper';
import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';

import { decodePiConfig } from '../config';

/** Persisted locators are host paths; protocol paths and canonical identities are target paths. */
export function piTargetPath(value: string, target?: ExecutionTarget): string {
  if (target?.method !== 'wsl') return value;
  if (value.startsWith('/') && !value.startsWith('//')) return path.posix.normalize(value);
  const mapped = createExecutionPathMapper(target).toTargetPath(value);
  if (!mapped) throw new Error(`Pi path cannot be mapped to WSL: ${value}`);
  return mapped;
}

export function piHostPath(value: string, target?: ExecutionTarget): string {
  if (target?.method !== 'wsl') return value;
  const mapped = createExecutionPathMapper(target).toHostPath(piTargetPath(value, target));
  if (!mapped) throw new Error(`Pi path cannot be mapped from WSL: ${value}`);
  return mapped;
}

export function samePiTargetPath(left: string, right: string, target?: ExecutionTarget): boolean {
  if (target?.method === 'wsl') return piTargetPath(left, target) === piTargetPath(right, target);
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === 'win32' ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase() : resolvedLeft === resolvedRight;
}

export async function resolvePiExecutionWorkingDirectory(host: ProviderRuntimeHost, hostWorkingDirectory: string): Promise<string> {
  const target = await resolveExecutionTargetAsync({ settings: decodePiConfig(host.config, host.selection), hostVaultPath: hostWorkingDirectory });
  return piTargetPath(hostWorkingDirectory, target);
}
