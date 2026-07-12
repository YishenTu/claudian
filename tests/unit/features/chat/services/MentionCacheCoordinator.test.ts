import { MentionCacheCoordinator } from '@/features/chat/services/MentionCacheCoordinator';

function createRegistration() {
  return {
    fileContextManager: {
      markFileCacheDirty: jest.fn(),
      markFolderCacheDirty: jest.fn(),
    },
  };
}

describe('MentionCacheCoordinator', () => {
  it('marks every registered tab cache dirty for structural vault changes', () => {
    const first = createRegistration();
    const second = createRegistration();
    const coordinator = new MentionCacheCoordinator(() => [first, second]);

    coordinator.markStructureDirty();

    expect(first.fileContextManager.markFileCacheDirty).toHaveBeenCalledTimes(1);
    expect(first.fileContextManager.markFolderCacheDirty).toHaveBeenCalledTimes(1);
    expect(second.fileContextManager.markFileCacheDirty).toHaveBeenCalledTimes(1);
    expect(second.fileContextManager.markFolderCacheDirty).toHaveBeenCalledTimes(1);
  });

  it('keeps folder caches intact for file content changes', () => {
    const registration = createRegistration();
    const coordinator = new MentionCacheCoordinator(() => [registration]);

    coordinator.markFilesDirty();

    expect(registration.fileContextManager.markFileCacheDirty).toHaveBeenCalledTimes(1);
    expect(registration.fileContextManager.markFolderCacheDirty).not.toHaveBeenCalled();
  });
});
