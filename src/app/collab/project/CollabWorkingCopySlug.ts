import { CollabPathPolicy } from '@/app/collab/CollabPathPolicy';

/** Application-owned portable directory grammar, not a wire identity predicate. */
export function isCollabWorkingCopySlug(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
}

export function collabWorkingCopySlugBase(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56)
    .replace(/-+$/g, '');
  return slug || 'project';
}

/** User-selected directory names may contain spaces and Unicode, while retaining portable path boundaries. */
export function isCollabWorkingCopyDirectoryName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 127 && !value.startsWith('.') && !value.includes('/')
    && new CollabPathPolicy().validateRepositoryPath(value).ok;
}
