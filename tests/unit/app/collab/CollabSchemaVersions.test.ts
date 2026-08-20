import {
  COLLAB_AUTHORITY_SCHEMA_VERSION,
  COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
} from '@/app/collab/CollabSchemaVersions';

describe('CollabSchemaVersions', () => {
  it('freezes the app-owned persistence schema versions', () => {
    expect(COLLAB_LOCAL_PROJECT_SCHEMA_VERSION).toBe(2);
    expect(COLLAB_AUTHORITY_SCHEMA_VERSION).toBe(11);
  });
});
