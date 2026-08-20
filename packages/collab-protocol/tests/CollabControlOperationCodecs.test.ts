import {
  COLLAB_CONTROL_OPERATION_CODECS,
  COLLAB_LIMITS,
  collabControlOperationCodec,
} from '../src/index';

function envelope(data: unknown): unknown {
  return data;
}

describe('CollabControlOperationCodecs', () => {
  it('exposes request and response decoders for every executable codec', () => {
    expect(Object.isFrozen(COLLAB_CONTROL_OPERATION_CODECS)).toBe(true);
    for (const codec of Object.values(COLLAB_CONTROL_OPERATION_CODECS)) {
      expect(Object.isFrozen(codec)).toBe(true);
      expect(codec.decodeRequest).toEqual(expect.any(Function));
      expect(codec.decodeResponse).toEqual(expect.any(Function));
    }
    expect(collabControlOperationCodec('acceptRequest'))
      .toBe(COLLAB_CONTROL_OPERATION_CODECS.acceptRequest);
  });

  it.each(['__proto__', 'constructor', 'toString'])(
    'rejects inherited operation-map property %s',
    (operation) => {
      expect(() => collabControlOperationCodec(
        operation as keyof typeof COLLAB_CONTROL_OPERATION_CODECS,
      )).toThrow('collab.error.operation-failed');
    },
  );

  it('preserves permissive Request bodies and rejects unknown Ticket fields', () => {
    expect(collabControlOperationCodec('createComment').decodeRequest({
      body: 'Looks good',
      futureField: true,
      idempotencyKey: 'comment-one',
      projectId: 'project-a',
      requestId: 'request-a',
    }).status).toBe('ok');
    const ticket = collabControlOperationCodec('createTicketComment').decodeRequest({
      body: 'Looks good',
      futureField: true,
      idempotencyKey: 'comment-one',
      projectId: 'project-a',
      ticketId: 'ticket-a',
    });
    expect(ticket.status).toBe('invalid');
    const reason = ticket.status === 'invalid'
      ? ticket.error.safeContext.reason
      : undefined;
    expect(reason).toBe('ticket-comment-payload-invalid');
  });

  it('accepts additive Request fields without publishing them in the decoded DTO', () => {
    const decoded = collabControlOperationCodec('ensureMyRequest').decodeRequest({
      description: 'Ready',
      expectedMainOid: '1'.repeat(40),
      headOid: '2'.repeat(40),
      idempotencyKey: 'request-one',
      ingressPrincipal: { accountId: 'attacker' },
      memberCredential: 'must-not-cross-the-codec',
      memberId: 'attacker',
      projectId: 'project-a',
    });

    expect(decoded).toEqual({
      status: 'ok',
      value: {
        description: 'Ready',
        expectedMainOid: '1'.repeat(40),
        headOid: '2'.repeat(40),
        idempotencyKey: 'request-one',
        projectId: 'project-a',
      },
    });
  });

  it('applies one Project ID rule to every shared operation family', () => {
    const oversizedProjectId = 'p'.repeat(65);

    expect(collabControlOperationCodec('getRequest').decodeRequest({
      projectId: oversizedProjectId,
      requestId: 'request-a',
    }).status).toBe('invalid');
    expect(collabControlOperationCodec('getTicket').decodeRequest({
      projectId: oversizedProjectId,
      ticketId: 'ticket-a',
    }).status).toBe('invalid');
  });

  it('rejects oversized Request content using UTF-8 byte limits', () => {
    const oversized = '€'.repeat(Math.floor(COLLAB_LIMITS.maxRequestDescriptionBytes / 3) + 1);
    expect(new TextEncoder().encode(oversized).byteLength)
      .toBeGreaterThan(COLLAB_LIMITS.maxRequestDescriptionBytes);

    expect(collabControlOperationCodec('ensureMyRequest').decodeRequest({
      description: oversized,
      expectedMainOid: '1'.repeat(40),
      headOid: '2'.repeat(40),
      idempotencyKey: 'request-one',
      projectId: 'project-a',
    }).status).toBe('invalid');
  });

  it('rejects oversized response content using UTF-8 byte limits', () => {
    const now = '2026-08-18T00:00:00.000Z';
    const oversized = '€'.repeat(Math.floor(COLLAB_LIMITS.maxTicketBodyBytes / 3) + 1);
    const response = envelope({
      ticket: {
        acceptedRelations: [],
        body: oversized,
        comments: [],
        ticket: {
          authorMemberId: 'member-a',
          commentCount: 0,
          createdAt: now,
          id: 'ticket-a',
          number: 1,
          revision: 1,
          status: 'open',
          title: 'Title',
          updatedAt: now,
        },
      },
    });

    expect(() => collabControlOperationCodec('createTicket').decodeResponse(response))
      .toThrow('collab.error.protocol-payload-invalid');
  });

  it('enforces optional and unknown-field behavior through the decoders', () => {
    expect(collabControlOperationCodec('listTickets').decodeRequest({
      cursor: 'ticket_1',
      limit: 10,
      projectId: 'project-a',
      status: 'all',
    })).toMatchObject({ status: 'ok' });
    for (const cursor of [
      '',
      'c'.repeat(COLLAB_LIMITS.maxPageCursorUtf16 + 1),
    ]) {
      expect(collabControlOperationCodec('listTickets').decodeRequest({
        cursor,
        projectId: 'project-a',
        status: 'all',
      })).toMatchObject({ status: 'invalid' });
    }
    expect(collabControlOperationCodec('listTickets').decodeRequest({
      futureField: true,
      projectId: 'project-a',
      status: 'all',
    })).toMatchObject({
      status: 'invalid',
      error: { safeContext: { reason: 'ticket-list-query-invalid' } },
    });

  });
});
