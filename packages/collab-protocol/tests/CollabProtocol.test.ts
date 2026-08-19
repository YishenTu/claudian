import { COLLAB_PROTOCOL_VERSION } from '../src/CollabConstants';
import { decodeCollabProtocolEnvelope } from '../src/CollabProtocol';

describe('CollabProtocol', () => {
  it('decodes the exact current protocol envelope', () => {
    expect(decodeCollabProtocolEnvelope({
      data: { projectId: 'project_1' },
      protocolVersion: COLLAB_PROTOCOL_VERSION,
      requestId: 'request_1',
    })).toEqual({
      status: 'ok',
      value: {
        data: { projectId: 'project_1' },
        protocolVersion: COLLAB_PROTOCOL_VERSION,
        requestId: 'request_1',
      },
    });
  });

  it('rejects unknown fields in current-schema envelopes', () => {
    expect(decodeCollabProtocolEnvelope({
      credential: 'must-not-be-accepted',
      data: {},
      protocolVersion: COLLAB_PROTOCOL_VERSION,
      requestId: 'request_1',
    })).toMatchObject({
      status: 'invalid',
      error: { code: 'protocol-payload-invalid' },
    });
  });

  it('returns a compatibility result for unsupported protocol versions', () => {
    expect(decodeCollabProtocolEnvelope({
      data: {},
      protocolVersion: 999,
      requestId: 'request_1',
    })).toMatchObject({
      status: 'unsupported-version',
      receivedVersion: 999,
      error: { code: 'protocol-version-unsupported' },
    });
  });

});
