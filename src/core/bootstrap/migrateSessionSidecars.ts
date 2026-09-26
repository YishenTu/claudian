import type { VaultFileAdapter } from '../storage/VaultFileAdapter';
import { isValidSessionMetadataId } from './SessionStorage';
import { getDeviceSessionsPath, isDeviceSettingsKey, LEGACY_SESSIONS_PATH, SESSIONS_PATH } from './storagePaths';

/** Finish assignment/deletion recovery and return obsolete inputs for deferred cleanup. Safe to retry. */
export async function migrateSessionSidecars(adapter: VaultFileAdapter): Promise<string[]> {
  const files = await adapter.listFilesRecursive(SESSIONS_PATH);
  for (const file of files) {
    if (!file.endsWith('.assigned.json')) continue;
    const id = file.slice(file.lastIndexOf('/') + 1, -'.assigned.json'.length);
    if (!isValidSessionMetadataId(id)) continue;
    let content: string;
    try {
      content = await adapter.read(file);
    } catch (error) {
      if (!await adapter.exists(file)) continue;
      throw error;
    }
    let assignment: unknown;
    try {
      assignment = JSON.parse(content);
    } catch {
      // An unreadable old marker cannot establish ownership; retain metadata in place.
    }
    if (!assignment || typeof assignment !== 'object'
      || !('schemaVersion' in assignment) || assignment.schemaVersion !== 1
      || !('conversationId' in assignment) || assignment.conversationId !== id
      || !('deviceKey' in assignment) || !isDeviceSettingsKey(assignment.deviceKey)) {
      await adapter.delete(file);
      continue;
    }
    const source = `${SESSIONS_PATH}/${id}.meta.json`;
    const targetFolder = getDeviceSessionsPath(assignment.deviceKey);
    const target = `${targetFolder}/${id}.meta.json`;
    if (await adapter.exists(source)) {
      if (await adapter.exists(target)) {
        await adapter.delete(source);
      } else {
        await adapter.ensureFolder(targetFolder);
        await adapter.rename(source, target);
      }
    }
    await adapter.delete(`${LEGACY_SESSIONS_PATH}/${id}.meta.json`);
    await adapter.delete(file);
  }
  for (const file of files) {
    if (file.endsWith('.deleted.json')) {
      const id = file.slice(file.lastIndexOf('/') + 1, -'.deleted.json'.length);
      if (!isValidSessionMetadataId(id)) continue;
      const folder = file.slice(0, file.lastIndexOf('/'));
      await adapter.delete(`${folder}/${id}.meta.json`);
      if (folder === SESSIONS_PATH) {
        await adapter.delete(`${LEGACY_SESSIONS_PATH}/${id}.meta.json`);
      }
      await adapter.delete(file);
    }
  }
  return files.filter(file => file.endsWith('.inputs.json'));
}
