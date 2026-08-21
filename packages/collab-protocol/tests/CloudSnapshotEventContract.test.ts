import {
  COLLAB_CLOUD_EVENT_KINDS,
  COLLAB_CLOUD_PROJECT_SNAPSHOT_CODEC,
  COLLAB_MAIN_REF,
  COLLAB_PROTOCOL_VERSION,
  collabMemberRef,
  decodeCollabCloudProjectEventMessage,
  decodeCollabCloudProjectSnapshot,
} from '../src/index';

const NOW = '2026-08-21T00:00:00.000Z';
const EARLIER = '2026-08-20T00:00:00.000Z';
const MAIN = '1'.repeat(40);
const HEAD_ONE = '2'.repeat(40);
const HEAD_TWO = '3'.repeat(40);

function member(memberId: string, role: 'manager' | 'member') {
  return {
    activatedAt: NOW,
    createdAt: EARLIER,
    displayName: memberId === 'member_1' ? 'Alice' : 'Bob',
    id: memberId,
    personalRef: collabMemberRef(memberId),
    role,
    status: 'active',
  };
}

function request(requestId: string, memberId: string, headOid: string) {
  return {
    commentCount: 0,
    createdAt: EARLIER,
    description: 'Ready',
    firstBaseOid: MAIN,
    id: requestId,
    latestHeadOid: headOid,
    memberId,
    revision: 1,
    status: 'open',
    ticketRelations: [],
    updatedAt: NOW,
  };
}

function ticket(ticketId: string, number: number, updatedAt: string) {
  return {
    acceptedRelationCount: 0,
    authorMemberId: 'member_1',
    commentCount: 0,
    createdAt: EARLIER,
    id: ticketId,
    number,
    revision: 1,
    status: 'open',
    title: `Ticket ${number}`,
    updatedAt,
  };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    currentMember: member('member_1', 'manager'),
    eventSequence: 12,
    members: [
      member('member_1', 'manager'),
      member('member_2', 'member'),
    ],
    openRequests: [
      request('request_1', 'member_1', HEAD_ONE),
      request('request_2', 'member_2', HEAD_TWO),
    ],
    openTicketCount: 2,
    project: {
      createdAt: EARLIER,
      expectedMainOid: MAIN,
      id: 'project_1',
      mainRef: COLLAB_MAIN_REF,
      name: 'Private project',
    },
    ticketHighlights: [
      ticket('ticket_2', 2, NOW),
      ticket('ticket_1', 1, EARLIER),
    ],
    ...overrides,
  };
}

describe('Cloud Project snapshot', () => {
  it('decodes the exact authority-neutral bounded projection', () => {
    expect(decodeCollabCloudProjectSnapshot(snapshot())).toEqual(snapshot());
    expect(JSON.stringify(decodeCollabCloudProjectSnapshot(snapshot())))
      .not.toMatch(/host|credential|endpoint|placement|managerSetGeneration/i);
  });

  it.each([
    snapshot({ futureField: true }),
    snapshot({ project: { ...snapshot().project, hostMemberId: 'member_1' } }),
    snapshot({ currentMember: member('member_3', 'member') }),
    snapshot({ members: [member('member_2', 'member'), member('member_1', 'manager')] }),
    snapshot({ openRequests: [
      request('request_2', 'member_2', HEAD_TWO),
      request('request_1', 'member_1', HEAD_ONE),
    ] }),
    snapshot({ ticketHighlights: [
      ticket('ticket_1', 1, EARLIER),
      ticket('ticket_2', 2, NOW),
    ] }),
    snapshot({ openTicketCount: 1 }),
  ])('rejects mixed, unsorted, or extended snapshot state %#', (input) => {
    expect(() => decodeCollabCloudProjectSnapshot(input))
      .toThrow('collab.error.protocol-payload-invalid');
  });

  it('owns the exact getProjectSnapshot request/response codec', () => {
    expect(COLLAB_CLOUD_PROJECT_SNAPSHOT_CODEC.decodeRequest({ projectId: 'project_1' }))
      .toEqual({ status: 'ok', value: { projectId: 'project_1' } });
    expect(COLLAB_CLOUD_PROJECT_SNAPSHOT_CODEC.decodeRequest({
      projectId: 'project_1',
      role: 'manager',
    }).status).toBe('invalid');
    expect(COLLAB_CLOUD_PROJECT_SNAPSHOT_CODEC.decodeResponse(snapshot()))
      .toEqual(snapshot());
  });
});

describe('Cloud Project events', () => {
  it('freezes six redacted durable kinds and decodes their exact payloads', () => {
    expect(COLLAB_CLOUD_EVENT_KINDS).toEqual([
      'membership.updated',
      'request.updated',
      'request.comment-added',
      'ticket.updated',
      'ticket.comment-added',
      'main.updated',
    ]);
    const events = [
      { kind: 'membership.updated', payload: { memberId: 'member_1' } },
      { kind: 'request.updated', payload: { requestId: 'request_1' } },
      { kind: 'request.comment-added', payload: { requestId: 'request_1' } },
      { kind: 'ticket.updated', payload: { ticketId: 'ticket_1' } },
      { kind: 'ticket.comment-added', payload: { ticketId: 'ticket_1' } },
      { kind: 'main.updated', payload: { mainOid: MAIN, requestId: 'request_1' } },
    ];
    for (const [index, event] of events.entries()) {
      const envelope = {
        ...event,
        occurredAt: NOW,
        projectId: 'project_1',
        protocolVersion: 4,
        sequence: index + 1,
      };
      expect(decodeCollabCloudProjectEventMessage(envelope)).toEqual(envelope);
    }
  });

  it('decodes snapshot.required as the only non-durable stream instruction', () => {
    expect(decodeCollabCloudProjectEventMessage({
      kind: 'snapshot.required',
      latestSequence: 12,
    })).toEqual({ kind: 'snapshot.required', latestSequence: 12 });
  });

  it.each([
    {
      kind: 'future.event',
      occurredAt: NOW,
      payload: {},
      projectId: 'project_1',
      protocolVersion: COLLAB_PROTOCOL_VERSION,
      sequence: 1,
    },
    {
      kind: 'request.comment-added',
      occurredAt: NOW,
      payload: { body: 'secret', requestId: 'request_1' },
      projectId: 'project_1',
      protocolVersion: COLLAB_PROTOCOL_VERSION,
      sequence: 1,
    },
    {
      kind: 'main.updated',
      occurredAt: NOW,
      payload: { mainOid: MAIN, requestId: 'request_1' },
      projectId: 'project_1',
      protocolVersion: 3,
      sequence: 1,
    },
    {
      kind: 'snapshot.required',
      latestSequence: 12,
      reason: 'gap',
    },
  ])('rejects unknown, content-rich, incompatible, or extended messages %#', (input) => {
    expect(() => decodeCollabCloudProjectEventMessage(input))
      .toThrow('collab.error.protocol-payload-invalid');
  });
});
