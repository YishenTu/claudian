export interface MentionCacheRegistration {
  fileContextManager: {
    markFileCacheDirty(): void;
    markFolderCacheDirty(): void;
  } | null;
}

/** Owns vault-event invalidation for the existing per-tab mention caches. */
export class MentionCacheCoordinator {
  constructor(
    private readonly getRegistrations: () => Iterable<MentionCacheRegistration>,
  ) {}

  markStructureDirty(): void {
    for (const registration of this.getRegistrations()) {
      registration.fileContextManager?.markFileCacheDirty();
      registration.fileContextManager?.markFolderCacheDirty();
    }
  }

  markFilesDirty(): void {
    for (const registration of this.getRegistrations()) {
      registration.fileContextManager?.markFileCacheDirty();
    }
  }
}
