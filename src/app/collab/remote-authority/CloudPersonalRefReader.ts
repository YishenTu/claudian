import {
  COLLAB_LIMITS,
  collabCloudGitRoute,
  isCollabProjectId,
} from '@claudian-collab/protocol';

import {
  cloudAuthorityError,
  cloudAuthorityProtocolError,
} from '@/app/collab/remote-authority/CloudAuthorityError';
import { resolveCloudRoute } from '@/app/collab/remote-authority/CloudAuthorityUrls';
import { requestCloudAuthorityBytes } from '@/app/collab/remote-authority/NodeCloudAuthorityBufferedTransport';
import type { CollabError } from '@/core/collab/ClaudianCollabError';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const ADVERTISEMENT_CONTENT_TYPE = 'application/x-git-upload-pack-advertisement';
const SERVICE_ANNOUNCEMENT = '# service=git-upload-pack\n';
const REF_NAME = /^refs\/(?:heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const OID = /^[0-9a-f]{40}$/u;

export interface CloudPersonalRefReadInput {
  readonly headers: Readonly<Record<string, string>>;
  readonly personalRef: string;
  readonly projectId: string;
  readonly serverUrl: string;
  readonly signal?: AbortSignal;
}

function protocolError(reason: string): CollabError {
  return cloudAuthorityProtocolError(reason);
}

export class CloudPersonalRefReader {
  constructor(private readonly timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new TypeError('Cloud personal-ref timeout must be positive');
    }
  }

  async read(input: CloudPersonalRefReadInput): Promise<string> {
    if (!isCollabProjectId(input.projectId) || !REF_NAME.test(input.personalRef)) {
      throw new TypeError('Invalid Cloud personal-ref read input');
    }
    const route = collabCloudGitRoute(
      input.projectId,
      'info-refs',
      'git-upload-pack',
    );
    const response = await requestCloudAuthorityBytes({
      headers: {
        ...input.headers,
        'cache-control': 'no-cache',
        pragma: 'no-cache',
      },
      maximumBytes: COLLAB_LIMITS.maxJsonPayloadUtf8Bytes,
      method: route.method,
      ...(input.signal ? { signal: input.signal } : {}),
      timeoutMs: this.timeoutMs,
      url: resolveCloudRoute(input.serverUrl, route.target),
    }, {
      cancelled: () => cloudAuthorityError(
        'cancelled',
        'cloud-personal-ref-request-cancelled',
      ),
      invalidResponse: () => protocolError('cloud-personal-ref-response-invalid'),
      responseTooLarge: () => protocolError('cloud-personal-ref-response-too-large'),
      timedOut: () => cloudAuthorityError(
        'operation-timeout',
        'cloud-personal-ref-request-timeout',
      ),
      unreachable: () => cloudAuthorityError(
        'endpoint-unreachable',
        'cloud-personal-ref-request-failed',
      ),
    });
    if (
      response.status !== 200
      || response.contentType !== ADVERTISEMENT_CONTENT_TYPE
    ) throw protocolError('cloud-personal-ref-response-metadata-invalid');
    return parsePersonalRefAdvertisement(response.body, input.personalRef);
  }
}

function parsePersonalRefAdvertisement(body: Buffer, personalRef: string): string {
  let offset = 0;
  const packet = (): Buffer | null => {
    if (offset + 4 > body.length) {
      throw protocolError('cloud-personal-ref-packet-truncated');
    }
    const prefix = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/u.test(prefix)) {
      throw protocolError('cloud-personal-ref-packet-length-invalid');
    }
    const length = Number.parseInt(prefix, 16);
    offset += 4;
    if (length === 0) return null;
    if (length < 5 || offset + length - 4 > body.length) {
      throw protocolError('cloud-personal-ref-packet-truncated');
    }
    const payload = body.subarray(offset, offset + length - 4);
    offset += length - 4;
    return payload;
  };

  const service = packet();
  if (service?.toString('ascii') !== SERVICE_ANNOUNCEMENT || packet() !== null) {
    throw protocolError('cloud-personal-ref-service-invalid');
  }
  const refs = new Set<string>();
  let matchingOid: string | null = null;
  let first = true;
  for (;;) {
    const advertised = packet();
    if (advertised === null) break;
    if (advertised[advertised.length - 1] !== 0x0a) {
      throw protocolError('cloud-personal-ref-line-invalid');
    }
    const line = advertised.subarray(0, -1).toString('utf8');
    if (line.includes('\uFFFD') || line.startsWith('version ')) {
      throw protocolError('cloud-personal-ref-version-invalid');
    }
    const nul = line.indexOf('\0');
    if ((!first && nul !== -1) || (first && line.indexOf('\0', nul + 1) !== -1)) {
      throw protocolError('cloud-personal-ref-capabilities-invalid');
    }
    const identity = nul === -1 ? line : line.slice(0, nul);
    const split = identity.indexOf(' ');
    const oid = identity.slice(0, split);
    const ref = identity.slice(split + 1);
    const peeledTag = ref.endsWith('^{}') ? ref.slice(0, -3) : null;
    if (
      split !== 40
      || !OID.test(oid)
      || (
        ref !== 'HEAD'
        && !REF_NAME.test(ref)
        && !(peeledTag?.startsWith('refs/tags/') && REF_NAME.test(peeledTag))
      )
      || (peeledTag !== null && !refs.has(peeledTag))
    ) {
      throw protocolError('cloud-personal-ref-line-invalid');
    }
    if (refs.has(ref)) throw protocolError('cloud-personal-ref-duplicate');
    refs.add(ref);
    if (peeledTag === null && ref === personalRef) matchingOid = oid;
    first = false;
  }
  if (offset !== body.length || matchingOid === null) {
    throw protocolError('cloud-personal-ref-missing');
  }
  return matchingOid;
}
