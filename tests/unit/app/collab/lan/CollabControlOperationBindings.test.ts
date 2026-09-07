import {
COLLAB_CONTROL_OPERATION_BINDINGS,
collabControlOperationPath,
matchCollabControlOperation,
} from '@/app/collab/lan/CollabControlOperationBindings';
import {
lanCollabControlOperationCodec
} from '@/app/collab/lan/LanCollabControlOperationCodecs';

describe('CollabControlOperationBindings', () => {
  it('rejects inherited keys when resolving an operation codec', () => {
    for (const operation of ['__proto__', 'constructor', 'toString']) {
      expect(() => lanCollabControlOperationCodec(operation as never))
        .toThrow('collab.error.operation-failed');
    }
  });

  it('assigns a unique route to every JSON control operation', () => {
    const bindings = Object.values(COLLAB_CONTROL_OPERATION_BINDINGS);
    expect(new Set(bindings.map(binding => (
      `${binding.method} /v${binding.version}/projects/:projectId/${binding.route}`
    ))).size).toBe(bindings.length);
  });

  it('builds parameterized paths from the authoritative binding', () => {
    expect(collabControlOperationPath('createComment', 'project-a', {
      requestId: 'request-a',
    })).toBe('/v9/projects/project-a/requests/request-a/comments');
    expect(() => collabControlOperationPath('createComment', 'project-a'))
      .toThrow('Missing Collab route parameter: requestId');
  });

  it('matches parameterized routes from the same authoritative binding', () => {
    expect(matchCollabControlOperation('POST', [
      'requests', 'request-a', 'comments',
    ])).toEqual({
      operation: 'createComment',
      parameters: { requestId: 'request-a' },
    });
    expect(matchCollabControlOperation('GET', [
      'manager-responsibility-offers', 'current',
    ])).toEqual({
      operation: 'getCurrentManagerResponsibilityOffer',
      parameters: {},
    });
    expect(matchCollabControlOperation('POST', ['requests', '../bad', 'comments']))
      .toBeNull();
  });
});
