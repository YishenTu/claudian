import type { AgentInfo } from '@qoder-ai/qoder-agent-sdk';

import type { SlashCommand } from '../../core/types';
import type { QoderDiscoveredModel } from './models';

export interface QoderForkSource {
  resumeAt: string;
  sessionId: string;
}

export interface QoderDiscoverySnapshot {
  agents?: AgentInfo[];
  commands?: SlashCommand[];
  plugins?: Array<{ name?: string; path?: string; source?: string }>;
  skills?: string[];
}

export interface QoderProviderState {
  checkpointUserMessageIds?: string[];
  discovery?: QoderDiscoverySnapshot;
  forkSource?: QoderForkSource;
  lastKnownTitle?: string;
  sessionId?: string;
}

export interface QoderRuntimeSnapshot {
  agents: AgentInfo[];
  commands: SlashCommand[];
  models: QoderDiscoveredModel[];
  skills: string[];
}

export type QoderAuthMode = 'auto' | 'pat-env' | 'qodercli';

export function parseQoderProviderState(value: unknown): QoderProviderState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const record = value as Record<string, unknown>;
  const forkSource = parseQoderForkSource(record.forkSource);
  const checkpointUserMessageIds = Array.isArray(record.checkpointUserMessageIds)
    ? record.checkpointUserMessageIds.filter(
      (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
    )
    : undefined;
  const discovery = parseQoderDiscoverySnapshot(record.discovery);
  const lastKnownTitle = readTrimmedString(record.lastKnownTitle);
  const sessionId = readTrimmedString(record.sessionId);

  return {
    ...(checkpointUserMessageIds?.length ? { checkpointUserMessageIds } : {}),
    ...(discovery ? { discovery } : {}),
    ...(forkSource ? { forkSource } : {}),
    ...(lastKnownTitle ? { lastKnownTitle } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

export function buildPersistedQoderProviderState(
  state: QoderProviderState,
): QoderProviderState | undefined {
  const persisted = parseQoderProviderState(state);
  return Object.keys(persisted).length > 0 ? persisted : undefined;
}

function parseQoderForkSource(value: unknown): QoderForkSource | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const sessionId = readTrimmedString(record.sessionId);
  const resumeAt = readTrimmedString(record.resumeAt);
  return sessionId && resumeAt ? { resumeAt, sessionId } : undefined;
}

function parseQoderDiscoverySnapshot(value: unknown): QoderDiscoverySnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const commands = Array.isArray(record.commands)
    ? record.commands.filter(isSlashCommand)
    : undefined;
  const agents = Array.isArray(record.agents)
    ? record.agents.filter(isAgentInfo)
    : undefined;
  const skills = Array.isArray(record.skills)
    ? record.skills.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : undefined;
  const plugins = Array.isArray(record.plugins)
    ? record.plugins.filter(isPluginInfoLike)
    : undefined;

  const snapshot: QoderDiscoverySnapshot = {
    ...(agents?.length ? { agents } : {}),
    ...(commands?.length ? { commands } : {}),
    ...(plugins?.length ? { plugins } : {}),
    ...(skills?.length ? { skills } : {}),
  };
  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

function isSlashCommand(value: unknown): value is SlashCommand {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as SlashCommand).name === 'string'
    && typeof (value as SlashCommand).description === 'string';
}

function isAgentInfo(value: unknown): value is AgentInfo {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as AgentInfo).name === 'string';
}

function isPluginInfoLike(
  value: unknown,
): value is { name?: string; path?: string; source?: string } {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
