import {
  collabCloudGitRoute,
  isCollabProjectId,
} from '@claudian/collab-protocol';

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '[::1]' || hostname === 'localhost';
}

export function canonicalCloudOrigin(candidate: string, key: string): string {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new TypeError(`Invalid ${key}`);
  }
  if (
    (parsed.protocol !== 'https:'
      && !(parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname)))
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.pathname !== '/'
    || parsed.search.length > 0
    || parsed.hash.length > 0
  ) {
    throw new TypeError(`Invalid ${key}`);
  }
  return parsed.toString();
}

export function canonicalCloudUrl(candidate: string, key: string): string {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new TypeError(`Invalid ${key}`);
  }
  if (
    (parsed.protocol !== 'https:'
      && !(parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname)))
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.search.length > 0
    || parsed.hash.length > 0
  ) {
    throw new TypeError(`Invalid ${key}`);
  }
  return parsed.toString();
}

export function cloudProjectGitRemoteUrl(
  serverUrl: string,
  projectId: string,
): string {
  if (!isCollabProjectId(projectId)) throw new TypeError('Invalid projectId');
  const origin = canonicalCloudOrigin(serverUrl, 'serverUrl');
  const uploadPack = collabCloudGitRoute(projectId, 'git-upload-pack').target;
  const suffix = '/git-upload-pack';
  if (!uploadPack.endsWith(suffix)) throw new TypeError('Invalid Cloud Git route');
  return new URL(uploadPack.slice(0, -suffix.length), origin).toString();
}
