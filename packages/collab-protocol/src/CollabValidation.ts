const COLLAB_PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const COLLAB_MEMBER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const COLLAB_OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const COLLAB_GIT_OID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export function isCollabProjectId(value: unknown): value is string {
  return typeof value === 'string' && COLLAB_PROJECT_ID_PATTERN.test(value);
}

export function isCollabMemberId(value: unknown): value is string {
  return typeof value === 'string' && COLLAB_MEMBER_ID_PATTERN.test(value);
}

export function isCollabOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && COLLAB_OPAQUE_ID_PATTERN.test(value);
}

export function isCollabGitOid(value: unknown): value is string {
  return typeof value === 'string' && COLLAB_GIT_OID_PATTERN.test(value);
}

export function hasUtf8ByteLengthAtMost(value: string, maximum: number): boolean {
  return new TextEncoder().encode(value).byteLength <= maximum;
}
