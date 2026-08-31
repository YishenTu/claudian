import {
  cloudProjectGitRemoteUrl,
  resolveCloudRoute,
  validateCloudServerUrl,
} from '@/app/collab/remote-authority/CloudAuthorityUrls';

describe('Cloud authority URLs', () => {
  it('retains the raw non-loopback HTTP base and derives every route below its prefix', () => {
    const raw = 'HTTP://198.51.100.20:8080/operator/cloud';
    expect(validateCloudServerUrl(raw, 'serverUrl')).toBe(raw);
    expect(resolveCloudRoute(raw, '/collab/capabilities'))
      .toBe('http://198.51.100.20:8080/operator/cloud/collab/capabilities');
    expect(cloudProjectGitRemoteUrl(raw, 'project-one'))
      .toBe('http://198.51.100.20:8080/operator/cloud/v3/projects/project-one/repository.git');
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
    expect(() => validateCloudServerUrl(candidate, 'serverUrl')).toThrow('Invalid serverUrl');
  });
});
