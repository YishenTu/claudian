/** @jest-environment jsdom */

import { fireEvent, waitFor, within } from '@testing-library/dom';
import { configureAxe } from 'jest-axe';

import { type CollabFeatureState, type CollabLocalProjectSummary } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

jest.mock('obsidian', () => ({
  ...jest.requireActual('../../../../__mocks__/obsidian'),
  Modal: class MockModal {
    readonly contentEl = document.createElement('div');
    readonly modalEl = document.createElement('div');
    close(): void { this.onClose(); this.contentEl.remove(); }
    open(): void { document.body.appendChild(this.contentEl); this.onOpen(); }
    setTitle(): void {}
    onClose(): void {}
    onOpen(): void {}
  },
}));

import { CollabPanel, type CollabPanelPort } from '@/features/collab/sidebar/CollabPanel';

const axe = configureAxe({ rules: { region: { enabled: false } } });

it('finishes Cloud Retire in one confirmation and presents local file choices without another active inspection', async () => {
  const project: CollabLocalProjectSummary = {
    authorityKind: 'cloud',
    connectionStatus: 'connected',
    health: 'healthy',
    hostInstallationStatus: 'not-host',
    hostStatus: 'not-host',
    id: 'project-alpha',
    name: 'Alpha',
    role: 'manager',
    workspacePath: 'workspace/alpha',
  };
  let state: CollabFeatureState = {
    lifecycle: 'ready', projects: [project], selectedProjectId: project.id,
  };
  const listeners = new Set<(state: CollabFeatureState) => void>();
  const currentMember = {
    id: 'member-manager', displayName: 'Alice', role: 'manager', status: 'active',
  };
  const port = {
    get state() { return state; },
    initialize: async () => ({ status: 'success', value: state }),
    observeProject: (_projectId: string, observer: () => void) => {
      const listener = () => observer();
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    subscribe: (listener: (state: CollabFeatureState) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    inspectProject: async () => {
      if (state.projects[0]?.lifecycle === 'retired') {
        throw new CollabError({ code: 'project-retired' });
      }
      return { status: 'cancelled' };
    },
    readSnapshot: async () => ({
      status: 'success', value: {
        snapshot: { currentMember, members: [currentMember], openRequests: [], project },
        source: 'online', stale: false, syncState: { status: 'synchronized' },
      },
    }),
    listTickets: async () => ({ status: 'success', value: { page: { tickets: [] } } }),
    readProjectCapabilities: async () => ({
      status: 'success', value: {
        authorityKind: 'cloud', authorityTransfer: false, importedMemberClaims: false,
        invitations: false, leave: false, managerResponsibility: false,
        membershipManagement: false, retirement: true,
      },
    }),
    readCloudToLanTransfer: async () => ({ status: 'success', value: null }),
    readManagementOperation: async () => ({ status: 'success', value: null }),
    retireProject: async () => {
      state = { ...state, projects: [{
        ...project, lifecycle: 'retired', cleanupStatus: 'complete',
        retiredAt: '2026-09-07T00:00:00.000Z',
      }] };
      for (const listener of listeners) listener(state);
      return { status: 'success', value: undefined };
    },
  } as unknown as CollabPanelPort;
  const container = document.body.createDiv();
  const panel = new CollabPanel(container, {} as never, {
    app: {
      vault: { on: jest.fn(), offref: jest.fn() },
      workspace: { getActiveFile: () => null },
    } as never,
    configuredGitPath: () => '',
    onSaveConfiguredGitPath: jest.fn(),
    port,
    projectSetup: { getPendingSetupOperationId: async () => null },
    resolveGit: async () => ({ status: 'available', version: '2.45.1' }),
  });
  try {
    panel.setActive(true);
    await waitFor(() => expect(within(container).getByRole('button', { name: 'Project management' })).toBeTruthy());
    fireEvent.click(within(container).getByRole('button', { name: 'Project management' }));
    await waitFor(() => expect(within(document.body).getByRole('button', { name: 'Retire project' })).toBeTruthy());
    fireEvent.click(within(document.body).getByRole('button', { name: 'Retire project' }));
    fireEvent.click(within(document.body).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => {
      expect(within(document.body).queryByRole('button', { name: 'Confirm' })).toBeNull();
      expect(within(container).getByRole('button', { name: 'Keep files' })).toBeTruthy();
      expect(within(container).getByRole('button', { name: 'Delete files' })).toBeTruthy();
    });
    expect(await axe(container)).toHaveNoViolations();
  } finally {
    panel.destroy();
    document.body.replaceChildren();
  }
});
