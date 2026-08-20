import { isCollabProjectId } from '@claudian/collab-protocol';

import { CollabError } from '@/core/collab/ClaudianCollabError';

const GIT_ROUTE_PREFIX = '/v1/git/';

export type CollabGitService = 'git-upload-pack' | 'git-receive-pack';
export type CollabGitRequestPhase = 'advertisement' | 'rpc';

export interface ParsedGitHttpRoute {
  readonly pathSuffix: '/git-receive-pack' | '/git-upload-pack' | '/info/refs';
  readonly phase: CollabGitRequestPhase;
  readonly projectId: string;
  readonly queryString: string;
  readonly service: CollabGitService;
}

function routeError(reason: string): CollabError {
  return new CollabError({
    code: 'path-invalid',
    recoveryActions: [],
    safeContext: { reason },
  });
}

export function isGitHttpRoute(url: string | undefined): boolean {
  return typeof url === 'string' && url.startsWith(GIT_ROUTE_PREFIX);
}

export function parseGitHttpRoute(method: string, rawUrl: string): ParsedGitHttpRoute {
  if (
    !rawUrl.startsWith(GIT_ROUTE_PREFIX)
    || rawUrl.includes('%')
    || rawUrl.includes('#')
    || rawUrl.includes('\\')
    || rawUrl.includes('\u0000')
  ) {
    throw routeError('git-route-invalid');
  }
  const querySeparator = rawUrl.indexOf('?');
  const pathname = querySeparator === -1 ? rawUrl : rawUrl.slice(0, querySeparator);
  const queryString = querySeparator === -1 ? '' : rawUrl.slice(querySeparator + 1);
  const match = /^\/v1\/git\/([^/]+)\/repository\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(
    pathname,
  );
  if (!match || !isCollabProjectId(match[1])) {
    throw routeError('git-route-invalid');
  }
  const suffix = match[2];
  if (suffix === 'info/refs') {
    const service = queryString === 'service=git-upload-pack'
      ? 'git-upload-pack'
      : queryString === 'service=git-receive-pack'
        ? 'git-receive-pack'
        : null;
    if (method !== 'GET' || !service) throw routeError('git-route-invalid');
    return {
      pathSuffix: '/info/refs',
      phase: 'advertisement',
      projectId: match[1],
      queryString,
      service,
    };
  }
  if (method !== 'POST' || queryString.length > 0) {
    throw routeError('git-route-invalid');
  }
  const service = suffix === 'git-upload-pack'
    ? 'git-upload-pack'
    : 'git-receive-pack';
  return {
    pathSuffix: service === 'git-upload-pack'
      ? '/git-upload-pack'
      : '/git-receive-pack',
    phase: 'rpc',
    projectId: match[1],
    queryString: '',
    service,
  };
}
