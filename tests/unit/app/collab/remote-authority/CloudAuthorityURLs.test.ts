import {
  cloudProjectGitRemoteURL,
  resolveCloudRoute,
  validateCloudServerURL,
} from '@/app/collab/remote-authority/CloudAuthorityURLs';

describe('Cloud authority URLs', () => {
  it('retains the raw non-loopback HTTP base and derives every route below its prefix', () => {
    const raw = 'HTTP://198.51.100.20:8080/operator/cloud';
    expect(validateCloudServerURL(raw, 'serverUrl')).toBe(raw);
    expect(resolveCloudRoute(raw, '/collab/capabilities'))
      .toBe('http://198.51.100.20:8080/operator/cloud/collab/capabilities');
    expect(cloudProjectGitRemoteURL(raw, 'project-one'))
      .toBe('http://198.51.100.20:8080/operator/cloud/v10/projects/project-one/repository.git');
  });

  it.each([
    ' https://cloud.example.test/base',
    'https:cloud.example.test/base',
    'https://cloud.example.test\\base',
    'https://cloud.example.test/base?',
    'https://cloud.example.test/base#',
    'https://cloud.example.test/base\u0085path',
    'https://cloud.example.test/base?token=value',
    'https://user:secret@cloud.example.test/base',
    'ftp://cloud.example.test/base',
  ])('rejects ambiguous or unsupported base %s without rewriting it', candidate => {
    expect(() => validateCloudServerURL(candidate, 'serverUrl')).toThrow('Invalid serverUrl');
  });
});
