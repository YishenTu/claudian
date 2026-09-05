interface CrashInput {
  readonly encodedInvitation?: string;
  readonly phase: string;
  readonly installationKey: string;
  readonly operationId: string;
  readonly projectId: string;
  readonly serverUrl: string;
  readonly vaultRoot: string;
}

async function run(input: CrashInput): Promise<void> {
  Object.assign(globalThis, {
    window: {
      clearInterval, clearTimeout, setInterval, setTimeout,
      addEventListener: () => undefined, removeEventListener: () => undefined,
    },
  });
  const [
    { CollabProjectWorkSessionRegistry }, { ClaudianCollabService },
    { CloudProjectEntryCoordinator }, { CloudAuthorityAdapter }, { parseInstallationKey },
    { decodeCloudProjectInvitation },
  ] = await Promise.all([
    import('@/app/collab/activity/CollabProjectWorkSession'),
    import('@/app/collab/ClaudianCollabService'),
    import('@/app/collab/project/CloudProjectEntryCoordinator'),
    import('@/app/collab/remote-authority/CloudAuthorityAdapter'),
    import('@/core/device/InstallationKey'),
    import('@/app/collab/project/CloudProjectInvitation'),
  ]);
  const foundation = new ClaudianCollabService({
    getConfiguredGitPath: () => '', installationKey: parseInstallationKey(input.installationKey),
    obsidianConfigDirectory: '.obsidian', vaultRoot: input.vaultRoot,
  });
  const sessions = new CollabProjectWorkSessionRegistry();
  const adapter = new CloudAuthorityAdapter(input.vaultRoot);
  const release = foundation.local.workspace.releaseReservedProjectsFolderChild.bind(foundation.local.workspace);
  foundation.local.workspace.releaseReservedProjectsFolderChild = async (...args) => {
    const released = await release(...args);
    if (input.phase === 'rename-before-checkpoint') {
      process.send?.({ phase: input.phase, type: 'durable-cut' });
      await new Promise<void>(() => {});
    }
    return released;
  };
  const save = foundation.local.projects.saveProjectDocument.bind(foundation.local.projects);
  foundation.local.projects.saveProjectDocument = async (...args) => {
    await save(...args);
    if (args[1] === 'pending-operation' && (args[2] as { phase?: string }).phase === input.phase) {
      process.send?.({ phase: input.phase, type: 'durable-cut' });
      await new Promise<void>(() => {});
    }
  };
  const entry = new CloudProjectEntryCoordinator(foundation, {
    activateProject: async membership => {
      const session = await sessions.acquire(input.projectId).ensureAuthoritySession(() => adapter.create(membership));
      await session.control.readSnapshot(input.projectId);
    },
    cloudAuthority: adapter,
    createId: kind => kind === 'project' ? input.projectId : input.operationId,
    getProjectsFolder: () => 'Shared/Projects',
    now: () => new Date('2026-09-01T00:00:00.000Z'),
    vaultRoot: input.vaultRoot,
  });
  try {
    if (input.encodedInvitation) {
      await entry.joinProject({ invitation: decodeCloudProjectInvitation(input.encodedInvitation), memberDisplayName: 'Bob', projectSlug: 'cloud-notes' });
    } else {
      await entry.createProject({ authority: { kind: 'cloud', serverUrl: input.serverUrl }, memberDisplayName: 'Alice', name: 'Cloud Notes' });
    }
    process.send?.({ type: 'unexpected-completion' });
  } finally {
    await entry.close();
    await sessions.close();
    await foundation.close();
  }
}

process.once('message', (input: CrashInput) => {
  process.channel?.ref();
  void run(input).catch(() => {
    process.send?.({ type: 'fixture-failed' });
    process.exitCode = 1;
  }).finally(() => process.disconnect?.());
});
