import {
  COLLAB_CLOUD_BINDING_LIMITS,
  COLLAB_CLOUD_BINDING_VERSION,
  COLLAB_CLOUD_CAPABILITIES,
  COLLAB_CLOUD_CAPABILITY_DOCUMENT_SCHEMA_VERSION,
  COLLAB_CLOUD_JSON_OPERATIONS,
  COLLAB_CONTROL_OPERATION_CODECS,
  COLLAB_PROTOCOL_VERSION,
  CollabError,
  collabCloudCapabilitySupported,
  collabCloudCapabilitiesRoute,
  collabCloudCapabilityDocument,
  collabCloudErrorEnvelope,
  collabCloudGitRoute,
  collabCloudProjectEventsRoute,
  collabCloudProjectOperationRoute,
  collabCloudSuccessEnvelope,
  collabDevelopmentBootstrapRoute,
  decodeCollabCloudCapabilityDocument,
  decodeCollabCloudErrorEnvelope,
  decodeCollabCloudSuccessEnvelope,
  matchCollabCloudRoute,
} from '../src/index';

const PROJECT_ID = 'project_1';

function capabilityDocument(overrides: Record<string, unknown> = {}) {
  return {
    bindingVersions: [1],
    capabilities: [...COLLAB_CLOUD_CAPABILITIES],
    limits: {
      maxDevelopmentBootstrapGitBundleBytes: 1024 * 1024 * 1024,
      maxDevelopmentBootstrapManifestUtf8Bytes: 64 * 1024,
      maxDevelopmentBootstrapReportUtf8Bytes: 64 * 1024,
      maxEventReplay: 500,
      maxGitReceivePackBytes: 256 * 1024 * 1024,
      maxJsonPayloadUtf8Bytes: 512 * 1024,
      maxRepositoryBytes: 1024 * 1024 * 1024,
    },
    protocolVersions: [4],
    schemaVersion: 1,
    ...overrides,
  };
}

describe('Cloud binding v1', () => {
  it('keeps package, canonical wire, Cloud binding, and LAN binding independent', () => {
    expect(COLLAB_PROTOCOL_VERSION).toBe(4);
    expect(COLLAB_CLOUD_BINDING_VERSION).toBe(1);
    expect(COLLAB_CLOUD_CAPABILITY_DOCUMENT_SCHEMA_VERSION).toBe(1);
    expect(Object.keys(COLLAB_CONTROL_OPERATION_CODECS)).toHaveLength(15);
    expect(COLLAB_CLOUD_JSON_OPERATIONS).toEqual([
      'getProjectSnapshot',
      ...Object.keys(COLLAB_CONTROL_OPERATION_CODECS),
    ]);
  });

  it('constructs and matches the exact package-owned route catalog', () => {
    const routes = [
      collabCloudCapabilitiesRoute(),
      collabCloudProjectOperationRoute(PROJECT_ID, 'getProjectSnapshot'),
      collabCloudProjectEventsRoute(PROJECT_ID, 42),
      collabCloudGitRoute(PROJECT_ID, 'info-refs', 'git-upload-pack'),
      collabCloudGitRoute(PROJECT_ID, 'git-upload-pack'),
      collabCloudGitRoute(PROJECT_ID, 'git-receive-pack'),
      collabDevelopmentBootstrapRoute('beginDevelopmentBootstrap'),
      collabDevelopmentBootstrapRoute('submitDevelopmentBootstrapReport', 'attempt_1'),
      collabDevelopmentBootstrapRoute('getDevelopmentBootstrap', 'attempt_1'),
      collabDevelopmentBootstrapRoute('activateDevelopmentBootstrap', 'attempt_1'),
      collabDevelopmentBootstrapRoute('cancelDevelopmentBootstrap', 'attempt_1'),
      collabDevelopmentBootstrapRoute('putDevelopmentBootstrapGitBundle', 'attempt_1'),
    ];

    expect(routes.map(route => `${route.method} ${route.target}`)).toEqual([
      'GET /collab/capabilities',
      'POST /v1/projects/project_1/operations/getProjectSnapshot',
      'GET /v1/projects/project_1/events?afterSequence=42',
      'GET /v1/projects/project_1/repository.git/info/refs?service=git-upload-pack',
      'POST /v1/projects/project_1/repository.git/git-upload-pack',
      'POST /v1/projects/project_1/repository.git/git-receive-pack',
      'POST /v1/development/bootstrap/attempts',
      'POST /v1/development/bootstrap/attempts/attempt_1/reports',
      'GET /v1/development/bootstrap/attempts/attempt_1',
      'POST /v1/development/bootstrap/attempts/attempt_1/activate',
      'POST /v1/development/bootstrap/attempts/attempt_1/cancel',
      'PUT /v1/development/bootstrap/attempts/attempt_1/git-bundle',
    ]);
    for (const route of routes) {
      expect(matchCollabCloudRoute(route.method, route.target)).toEqual(route.match);
    }
  });

  it('rejects unknown operations, non-canonical targets, and malformed identifiers', () => {
    expect(matchCollabCloudRoute(
      'POST',
      '/v1/projects/project_1/operations/futureOperation',
    )).toBeNull();
    expect(matchCollabCloudRoute(
      'GET',
      '/v1/projects/project_1/events?afterSequence=1&afterSequence=2',
    )).toBeNull();
    expect(matchCollabCloudRoute(
      'GET',
      '/v1/projects/project_1/repository.git/info/refs?service=git-archive',
    )).toBeNull();
    expect(matchCollabCloudRoute(
      'POST',
      '/v1//projects/project_1/operations/getProjectSnapshot',
    )).toBeNull();
    expect(matchCollabCloudRoute(
      'POST',
      '/v1/projects/project_1/operations/getProjectSnapshot/',
    )).toBeNull();
    expect(matchCollabCloudRoute('GET', '/collab/capabilities?')).toBeNull();
    expect(() => collabCloudProjectOperationRoute('../escape', 'getProjectSnapshot'))
      .toThrow('Invalid Collab Cloud route input');
  });

  it('decodes an exact compatible capability document and tolerates unknown tokens', () => {
    const capabilities = [
      'accept',
      'development-bootstrap',
      'future-read-plane',
      'git-receive-pack-personal-ref',
      'git-upload-pack',
      'project-events',
      'project-snapshot',
      'requests',
      'tickets',
    ];
    const decoded = decodeCollabCloudCapabilityDocument(capabilityDocument({ capabilities }));

    expect(decoded.capabilities).toEqual(capabilities);
    expect(collabCloudCapabilitySupported(decoded, 'project-snapshot')).toBe(true);
    expect(collabCloudCapabilitySupported(decoded, 'tickets')).toBe(true);
    expect(COLLAB_CLOUD_BINDING_LIMITS.maxEventReplay).toBe(500);
  });

  it('constructs the exact package-owned capability schema for server advertisement', () => {
    expect(collabCloudCapabilityDocument(
      [...COLLAB_CLOUD_CAPABILITIES],
      capabilityDocument().limits,
    )).toEqual(capabilityDocument());
  });

  it.each([
    capabilityDocument({ futureField: true }),
    capabilityDocument({ schemaVersion: 2 }),
    capabilityDocument({ bindingVersions: [2] }),
    capabilityDocument({ bindingVersions: [1, 2] }),
    capabilityDocument({ protocolVersions: [3] }),
    capabilityDocument({ protocolVersions: [4, 5] }),
    capabilityDocument({ capabilities: ['tickets', 'accept'] }),
    capabilityDocument({ capabilities: ['accept', 'accept'] }),
    capabilityDocument({ limits: { maxJsonPayloadUtf8Bytes: 512 * 1024 } }),
  ])('rejects a strict or incompatible capability document %#', (input) => {
    expect(() => decodeCollabCloudCapabilityDocument(input))
      .toThrow(CollabError);
  });

  it('round-trips strict success and safe error envelopes', () => {
    const success = collabCloudSuccessEnvelope('request_1', { ok: true });
    expect(decodeCollabCloudSuccessEnvelope(success)).toEqual(success);

    const error = collabCloudErrorEnvelope('request_1', new CollabError({
      code: 'authority-not-synchronized',
      recoveryActions: ['retry'],
      safeContext: { projectId: PROJECT_ID },
    }));
    expect(decodeCollabCloudErrorEnvelope(error)).toEqual(error);

    expect(() => decodeCollabCloudSuccessEnvelope({ ...success, extra: true }))
      .toThrow('collab.error.protocol-payload-invalid');
    expect(() => decodeCollabCloudErrorEnvelope({
      ...error,
      error: { ...error.error, credential: 'secret' },
    })).toThrow('collab.error.protocol-payload-invalid');
  });
});
