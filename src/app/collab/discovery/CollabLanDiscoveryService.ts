import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { type CollabProjectId, isCollabProjectId } from '@claudian/collab-protocol';
import Bonjour from 'bonjour-service';

import { InvitationCodec } from '@/app/collab/lan/InvitationCodec';
import { COLLAB_CONTROL_PROTOCOL_VERSION } from '@/app/collab/lan/LanCollabConstants';
import { type CollabOperationOptions } from '@/core/collab';

const COLLAB_DNS_SD_TYPE = 'claudian-collab';
const DEFAULT_DISCOVERY_TIMEOUT_MS = 3_000;
const DISCOVERY_RETRY_DELAYS_MS = [750, 1_750] as const;
const CANDIDATE_SETTLE_MS = 400;
const MAX_DISCOVERED_CANDIDATES = 8;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

export interface CollabDiscoveredHost {
  readonly caFingerprint: string;
  readonly endpoint: string;
  readonly projectId: CollabProjectId;
}

export interface CollabLanAdvertisement {
  stop(): Promise<void>;
}

export interface CollabLanDiscoveryPort {
  advertiseProject(host: CollabDiscoveredHost): Promise<CollabLanAdvertisement>;
  discoverProjectCandidates(
    projectId: CollabProjectId,
    caFingerprint: string,
    options?: CollabOperationOptions,
  ): Promise<readonly CollabDiscoveredHost[]>;
  discoverProjectCandidatesForTrustTransition(
    projectId: CollabProjectId,
    options?: CollabOperationOptions,
  ): Promise<readonly CollabDiscoveredHost[]>;
}

interface DnsSdService {
  readonly port: number;
  readonly txt?: unknown;
}

interface DnsSdBrowser {
  stop(): void;
  update(): void;
}

interface DnsSdPublication {
  stop(callback?: () => void): void;
}

interface DnsSdRuntime {
  browse(onService: (service: DnsSdService) => void): DnsSdBrowser;
  close(): Promise<void>;
  publish(input: {
    readonly name: string;
    readonly port: number;
    readonly txt: Readonly<Record<string, string>>;
  }): DnsSdPublication;
}

export interface CollabLanDiscoveryServiceOptions {
  readonly createRuntime?: (
    onError: (error: unknown) => void,
  ) => DnsSdRuntime;
  readonly discoveryTimeoutMs?: number;
  readonly invitationCodec?: InvitationCodec;
}

interface BonjourPrivateRuntime {
  readonly server?: {
    readonly mdns?: EventEmitter;
  };
}

class BonjourDnsSdRuntime implements DnsSdRuntime {
  private readonly bonjour: Bonjour;
  private readonly mdns: EventEmitter;

  constructor(onError: (error: unknown) => void) {
    this.bonjour = new Bonjour({}, onError);
    const internals = this.bonjour as unknown as BonjourPrivateRuntime;
    if (!(internals.server?.mdns instanceof EventEmitter)) {
      this.bonjour.destroy();
      throw new Error('Bonjour runtime does not expose its mDNS error source.');
    }
    this.mdns = internals.server.mdns;
    this.mdns.on('error', onError);
  }

  browse(onService: (service: DnsSdService) => void): DnsSdBrowser {
    return this.bonjour.find({
      protocol: 'tcp',
      type: COLLAB_DNS_SD_TYPE,
    }, onService);
  }

  close(): Promise<void> {
    return new Promise(resolve => this.bonjour.destroy(resolve));
  }

  publish(input: {
    readonly name: string;
    readonly port: number;
    readonly txt: Readonly<Record<string, string>>;
  }): DnsSdPublication {
    const publication = this.bonjour.publish({
      disableIPv6: true,
      name: input.name,
      port: input.port,
      probe: false,
      protocol: 'tcp',
      txt: input.txt,
      type: COLLAB_DNS_SD_TYPE,
    });
    const stop = publication.stop as (callback?: () => void) => void;
    return {
      stop: (callback) => stop.call(publication, callback),
    };
  }
}

function timeoutValue(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Collab LAN discovery timeout must be positive.');
  }
  return Math.floor(value);
}

function txtRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function publicationPort(endpoint: string, codec: InvitationCodec): number {
  return Number(new URL(codec.normalizeEndpoint(endpoint)).port);
}

function publicationName(projectId: string, endpoint: string): string {
  const instanceId = createHash('sha256')
    .update(`${projectId}\0${endpoint}`)
    .digest('hex')
    .slice(0, 12);
  return `Claudian Collab ${projectId.slice(0, 34)} ${instanceId}`;
}

export class CollabLanDiscoveryService implements CollabLanDiscoveryPort {
  private activeBrowsers = 0;
  private activePublications = 0;
  private closed = false;
  private readonly createRuntime: (onError: (error: unknown) => void) => DnsSdRuntime;
  private readonly discoveryTimeoutMs: number;
  private readonly errorListeners = new Set<() => void>();
  private readonly invitationCodec: InvitationCodec;
  private runtime: DnsSdRuntime | null = null;

  constructor(options: CollabLanDiscoveryServiceOptions = {}) {
    this.createRuntime = options.createRuntime
      ?? (onError => new BonjourDnsSdRuntime(onError));
    this.discoveryTimeoutMs = timeoutValue(
      options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
    );
    this.invitationCodec = options.invitationCodec ?? new InvitationCodec();
  }

  async advertiseProject(host: CollabDiscoveredHost): Promise<CollabLanAdvertisement> {
    if (this.closed) return { stop: () => Promise.resolve() };
    let endpoint: string;
    try {
      endpoint = this.validateHost(host).endpoint;
    } catch {
      return { stop: () => Promise.resolve() };
    }
    let publication: DnsSdPublication;
    try {
      publication = this.requireRuntime().publish({
        name: publicationName(host.projectId, endpoint),
        port: publicationPort(endpoint, this.invitationCodec),
        txt: {
          caFingerprint: host.caFingerprint,
          endpoint,
          projectId: host.projectId,
          protocolVersion: String(COLLAB_CONTROL_PROTOCOL_VERSION),
        },
      });
    } catch {
      await this.releaseRuntimeIfIdle();
      return { stop: () => Promise.resolve() };
    }
    this.activePublications += 1;
    let stopped = false;
    return {
      stop: async () => {
        if (stopped) return;
        stopped = true;
        await new Promise<void>(resolve => {
          publication.stop(() => resolve());
        });
        this.activePublications -= 1;
        await this.releaseRuntimeIfIdle();
      },
    };
  }

  async discoverProjectCandidates(
    projectId: CollabProjectId,
    caFingerprint: string,
    options: CollabOperationOptions = {},
  ): Promise<readonly CollabDiscoveredHost[]> {
    if (!FINGERPRINT_PATTERN.test(caFingerprint)) return [];
    return this.discoverCandidates(projectId, caFingerprint, options);
  }

  discoverProjectCandidatesForTrustTransition(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<readonly CollabDiscoveredHost[]> {
    return this.discoverCandidates(projectId, null, options);
  }

  private async discoverCandidates(
    projectId: CollabProjectId,
    caFingerprint: string | null,
    options: CollabOperationOptions,
  ): Promise<readonly CollabDiscoveredHost[]> {
    if (
      this.closed
      || options.signal?.aborted
      || !isCollabProjectId(projectId)
    ) {
      return [];
    }
    let runtime: DnsSdRuntime;
    try {
      runtime = this.requireRuntime();
    } catch {
      return [];
    }
    this.activeBrowsers += 1;
    let browser: DnsSdBrowser | null = null;
    try {
      return await new Promise<readonly CollabDiscoveredHost[]>(resolve => {
        const candidates = new Map<string, CollabDiscoveredHost>();
        let settled = false;
        let candidateSettleTimer: number | null = null;
        let retryTimers: number[] = [];
        const finish = (value: readonly CollabDiscoveredHost[]) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          if (candidateSettleTimer !== null) {
            window.clearTimeout(candidateSettleTimer);
          }
          for (const retryTimer of retryTimers) window.clearTimeout(retryTimer);
          retryTimers = [];
          options.signal?.removeEventListener('abort', onAbort);
          this.errorListeners.delete(onError);
          browser?.stop();
          resolve(value);
        };
        const onAbort = () => finish([]);
        const onError = () => finish([...candidates.values()]);
        const timer = window.setTimeout(
          () => finish([...candidates.values()]),
          this.discoveryTimeoutMs,
        );
        options.signal?.addEventListener('abort', onAbort, { once: true });
        this.errorListeners.add(onError);
        try {
          const createdBrowser = runtime.browse(service => {
            const candidate = this.decodeService(service);
            if (
              candidate?.projectId === projectId
              && (caFingerprint === null || candidate.caFingerprint === caFingerprint)
            ) {
              if (!candidates.has(candidate.endpoint)) {
                candidates.set(candidate.endpoint, candidate);
                if (candidates.size >= MAX_DISCOVERED_CANDIDATES) {
                  finish([...candidates.values()]);
                  return;
                }
                if (candidateSettleTimer !== null) {
                  window.clearTimeout(candidateSettleTimer);
                }
                candidateSettleTimer = window.setTimeout(
                  () => finish([...candidates.values()]),
                  CANDIDATE_SETTLE_MS,
                );
              }
            }
          });
          browser = createdBrowser;
          if (settled) {
            createdBrowser.stop();
          } else {
            retryTimers = DISCOVERY_RETRY_DELAYS_MS.map(delay => window.setTimeout(
              () => browser?.update(),
              delay,
            ));
          }
        } catch {
          finish([]);
        }
      });
    } finally {
      this.activeBrowsers -= 1;
      await this.releaseRuntimeIfIdle();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.errorListeners) listener();
    this.errorListeners.clear();
    const runtime = this.runtime;
    this.runtime = null;
    if (runtime) await runtime.close();
  }

  private decodeService(service: DnsSdService): CollabDiscoveredHost | null {
    const txt = txtRecord(service.txt);
    if (
      !txt
      || txt.protocolVersion !== String(COLLAB_CONTROL_PROTOCOL_VERSION)
      || typeof txt.projectId !== 'string'
      || typeof txt.caFingerprint !== 'string'
      || typeof txt.endpoint !== 'string'
      || !isCollabProjectId(txt.projectId)
      || !FINGERPRINT_PATTERN.test(txt.caFingerprint)
    ) {
      return null;
    }
    try {
      const endpoint = this.invitationCodec.normalizeEndpoint(txt.endpoint);
      if (Number(new URL(endpoint).port) !== service.port) return null;
      return {
        caFingerprint: txt.caFingerprint,
        endpoint,
        projectId: txt.projectId,
      };
    } catch {
      return null;
    }
  }

  private onRuntimeError = (): void => {
    for (const listener of [...this.errorListeners]) listener();
  };

  private releaseRuntimeIfIdle(): Promise<void> {
    if (this.activeBrowsers > 0 || this.activePublications > 0) {
      return Promise.resolve();
    }
    const runtime = this.runtime;
    this.runtime = null;
    return runtime?.close() ?? Promise.resolve();
  }

  private requireRuntime(): DnsSdRuntime {
    if (!this.runtime) this.runtime = this.createRuntime(this.onRuntimeError);
    return this.runtime;
  }

  private validateHost(host: CollabDiscoveredHost): CollabDiscoveredHost {
    if (
      !isCollabProjectId(host.projectId)
      || !FINGERPRINT_PATTERN.test(host.caFingerprint)
    ) {
      throw new Error('Collab LAN discovery identity is invalid.');
    }
    return {
      ...host,
      endpoint: this.invitationCodec.normalizeEndpoint(host.endpoint),
    };
  }
}
