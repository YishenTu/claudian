import {
  authenticateGitBasicRequest,
} from '@/app/collab/lan/git/GitBasicAuthentication';
import {
  parseGitHttpRoute,
} from '@/app/collab/lan/git/GitHttpRoute';

const CREDENTIAL = Buffer.alloc(32, 7).toString('base64url');

describe('Git Smart HTTP request boundary', () => {
  it.each([
    {
      method: 'GET',
      phase: 'advertisement',
      service: 'git-upload-pack',
      suffix: '/info/refs',
      url: '/v1/git/project-alpha/repository.git/info/refs?service=git-upload-pack',
    },
    {
      method: 'POST',
      phase: 'rpc',
      service: 'git-upload-pack',
      suffix: '/git-upload-pack',
      url: '/v1/git/project-alpha/repository.git/git-upload-pack',
    },
    {
      method: 'GET',
      phase: 'advertisement',
      service: 'git-receive-pack',
      suffix: '/info/refs',
      url: '/v1/git/project-alpha/repository.git/info/refs?service=git-receive-pack',
    },
    {
      method: 'POST',
      phase: 'rpc',
      service: 'git-receive-pack',
      suffix: '/git-receive-pack',
      url: '/v1/git/project-alpha/repository.git/git-receive-pack',
    },
  ])('accepts only the exact $service $phase route', input => {
    expect(parseGitHttpRoute(input.method, input.url)).toEqual({
      phase: input.phase,
      projectId: 'project-alpha',
      queryString: input.phase === 'advertisement'
        ? `service=${input.service}`
        : '',
      service: input.service,
      pathSuffix: input.suffix,
    });
  });

  it.each([
    ['GET', '/v1/git/project-alpha/repository.git/HEAD'],
    ['GET', '/v1/git/project-alpha/repository.git/info/refs'],
    ['GET', '/v1/git/project-alpha/repository.git/info/refs?service=git-upload-pack&x=1'],
    ['POST', '/v1/git/project-alpha/repository.git/info/refs?service=git-upload-pack'],
    ['GET', '/v1/git/project-alpha/repository.git/git-upload-pack'],
    ['POST', '/v1/git/project-alpha/repository.git/git-receive-pack?x=1'],
    ['POST', '/v1/git/../repository.git/git-upload-pack'],
    ['POST', '/v1/git/project-alpha%2frepository.git/git-upload-pack'],
    ['POST', '/v1/git/project-alpha/repository.git/%67it-upload-pack'],
    ['POST', '/v1/git/project-alpha/repository.git//git-upload-pack'],
  ])('rejects dumb, mismatched, encoded, or traversing routes', (method, url) => {
    expect(() => parseGitHttpRoute(method, url)).toThrow(expect.objectContaining({
      code: 'path-invalid',
    }));
  });

  it('authenticates Basic credentials and applies pending/active service policy', async () => {
    const authenticate = jest.fn(async (
      credential: string,
      statuses: readonly string[],
    ) => {
      expect(credential).toBe(CREDENTIAL);
      expect(statuses).toEqual(['pending', 'active']);
      return { member: { id: 'member-alice' } };
    });

    await expect(authenticateGitBasicRequest({
      authorization: `Basic ${Buffer.from(`member-alice:${CREDENTIAL}`).toString('base64')}`,
      authenticateMemberCredential: authenticate,
      service: 'git-upload-pack',
    })).resolves.toEqual({ memberId: 'member-alice' });
  });

  it('requires active membership for receive-pack and binds username to identity', async () => {
    const authenticate = jest.fn(async () => ({ member: { id: 'member-alice' } }));
    const authorization = `Basic ${Buffer.from(`member-mallory:${CREDENTIAL}`).toString('base64')}`;

    await expect(authenticateGitBasicRequest({
      authorization,
      authenticateMemberCredential: authenticate,
      service: 'git-receive-pack',
    })).rejects.toMatchObject({ code: 'authentication-failed' });
    expect(authenticate).toHaveBeenCalledWith(CREDENTIAL, ['active']);
  });

  it.each([
    null,
    '',
    'Bearer token',
    'Basic not-base64!',
    `Basic ${Buffer.from(`member-alice:${CREDENTIAL}:extra`).toString('base64')}`,
    `Basic ${Buffer.from(`member alice:${CREDENTIAL}`).toString('base64')}`,
    `Basic ${Buffer.from('member-alice:short').toString('base64')}`,
  ])('rejects malformed or anonymous authentication without exposing credentials', async authorization => {
    const authenticate = jest.fn();
    await expect(authenticateGitBasicRequest({
      authorization,
      authenticateMemberCredential: authenticate,
      service: 'git-upload-pack',
    })).rejects.toMatchObject({ code: 'authentication-failed' });
    expect(authenticate).not.toHaveBeenCalled();
  });
});
