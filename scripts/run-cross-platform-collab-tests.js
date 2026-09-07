const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const runJest = path.join(__dirname, 'run-jest.js');
const tests = [
  'tests/unit/utils/windowsCmdShim.test.ts',
  'tests/unit/core/process/ManagedStdioProcess.test.ts',
  'tests/unit/core/collab/CollabProjectsFolder.test.ts',
  'tests/unit/app/collab/local/CollabPathPolicy.test.ts',
  'tests/unit/app/collab/git/CollabGitOriginPolicy.test.ts',
  'tests/unit/app/collab/git/CollabGitTreePolicy.test.ts',
  'tests/unit/app/collab/git/GitCommandRunner.test.ts',
  'tests/unit/app/collab/git/GitCommandRunner.windows.test.ts',
  'tests/unit/app/collab/git/GitRepositoryService.test.ts',
  'tests/unit/app/collab/git/GitRuntimeResolver.test.ts',
  'tests/unit/app/collab/git/collabGitRefs.test.ts',
  'tests/unit/app/collab/lan/LanTlsIdentity.test.ts',
  'tests/unit/app/collab/publish/NativeGitPublicationCandidateRepository.test.ts',
  'tests/unit/app/collab/publish/NativeGitPublishRepository.test.ts',
  'tests/unit/app/collab/review/NativeGitReviewRepository.test.ts',
  'tests/unit/app/collab/review/NativeGitWorkingTreeReviewRepository.test.ts',
  'tests/integration/app/collab/conflicts/ConflictScratchGitRepository.test.ts',
  'tests/integration/app/collab/git-http/GitHttpBackendProxy.test.ts',
  'tests/integration/app/collab/git-http/GitHttpRoute.test.ts',
  'tests/integration/app/collab/git-http/GitReceiveHookPolicy.test.ts',
  'tests/integration/app/collab/git/GitRepositoryService.test.ts',
  'tests/integration/app/collab/git/GitRuntimeResolver.test.ts',
  'tests/integration/app/collab/reconciliation/NativeGitAcceptedStateIntegrator.test.ts',
  'tests/integration/app/collab/review/NativeGitReviewRepository.test.ts',
];

const result = spawnSync(process.execPath, [runJest, '--runInBand', ...tests], {
  cwd: root,
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
