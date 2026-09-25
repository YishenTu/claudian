import {
  collabCloudGitRoute,
  isCollabProjectId,
} from '@claudian-collab/protocol';

export function validateCloudServerURL(candidate: string, key: string): string {
  parseCloudURL(candidate, key);
  return candidate;
}

export function canonicalCloudURL(candidate: string, key: string): string {
  return parseCloudURL(candidate, key).toString();
}

function parseCloudURL(candidate: string, key: string): URL {
  if (
    !/^https?:\/\//iu.test(candidate)
    || /[\\\p{Cc} ?#]/u.test(candidate)
  ) throw new TypeError(`Invalid ${key}`);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new TypeError(`Invalid ${key}`);
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.search.length > 0
    || parsed.hash.length > 0
  ) {
    throw new TypeError(`Invalid ${key}`);
  }
  return parsed;
}

export function resolveCloudRoute(serverUrl: string, target: string): string {
  const base = parseCloudURL(serverUrl, 'serverUrl');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return new URL(target.slice(1), base).toString();
}

export function cloudProjectGitRemoteURL(
  serverUrl: string,
  projectId: string,
): string {
  if (!isCollabProjectId(projectId)) throw new TypeError('Invalid projectId');
  const uploadPack = collabCloudGitRoute(projectId, 'git-upload-pack').target;
  const suffix = '/git-upload-pack';
  if (!uploadPack.endsWith(suffix)) throw new TypeError('Invalid Cloud Git route');
  return resolveCloudRoute(serverUrl, uploadPack.slice(0, -suffix.length));
}
