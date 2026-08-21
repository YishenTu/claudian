import {
  COLLAB_CONTROL_OPERATION_CODECS,
  COLLAB_LIMITS,
  COLLAB_PROTOCOL_VERSION,
  collabControlOperationCodec,
} from '../src/index';

const NOW = '2026-08-18T00:00:00.000Z';
const MAIN = '1'.repeat(40);
const HEAD = '2'.repeat(40);
const COMMIT = '3'.repeat(40);

function changeRequest(overrides: Record<string, unknown> = {}) {
  return {
    commentCount: 0,
    createdAt: NOW,
    description: 'Ready',
    firstBaseOid: MAIN,
    id: 'request-a',
    latestHeadOid: HEAD,
    memberId: 'member-a',
    revision: 1,
    status: 'open',
    ticketRelations: [],
    updatedAt: NOW,
    ...overrides,
  };
}

function comment(id: string, requestId: string, body = 'Looks good') {
  return {
    authorMemberId: 'member-a',
    body,
    createdAt: NOW,
    id,
    requestId,
  };
}

function ticketSummary(overrides: Record<string, unknown> = {}) {
  return {
    acceptedRelationCount: 0,
    authorMemberId: 'member-a',
    commentCount: 0,
    createdAt: NOW,
    id: 'ticket-a',
    number: 1,
    revision: 1,
    status: 'open',
    title: 'Title',
    updatedAt: NOW,
    ...overrides,
  };
}

function ticketComment(id: string, ticketId: string, body = 'Noted') {
  return {
    authorMemberId: 'member-a',
    body,
    createdAt: NOW,
    id,
    ticketId,
  };
}

function acceptedRelation(id: string) {
  return {
    acceptedAt: NOW,
    acceptedMergeOid: COMMIT,
    commitOid: COMMIT,
    id,
    kind: 'resolves',
    requestId: 'request-a',
  };
}

describe('Canonical Collab wire protocol v4', () => {
  it('declares wire version 4 with finite collection and page limits', () => {
    expect(COLLAB_PROTOCOL_VERSION).toBe(4);
    expect(COLLAB_LIMITS.maxRequestComments).toBe(500);
    expect(COLLAB_LIMITS.maxTicketAcceptedRelations).toBe(2_000);
    expect(COLLAB_LIMITS.defaultCommentPageSize).toBe(50);
    expect(COLLAB_LIMITS.maxCommentPageSize).toBe(100);
    expect(COLLAB_LIMITS.commentPageMaxUtf8Bytes).toBe(128 * 1024);
    expect(COLLAB_LIMITS.maxRelationsPerPage).toBe(100);
    expect(COLLAB_LIMITS.relationPageMaxUtf8Bytes).toBe(96 * 1024);
    expect(COLLAB_LIMITS.maxPageCursorUtf16).toBe(512);
    expect(COLLAB_LIMITS.detailMaxUtf8Bytes).toBe(448 * 1024);
    expect(COLLAB_LIMITS.ticketPageMaxUtf8Bytes).toBe(96 * 1024);
    expect(COLLAB_LIMITS.maxJsonPayloadUtf8Bytes).toBe(512 * 1024);
  });

  it('keeps the detail budget coherent with the content limits', () => {
    // A detail must always carry a maximal body/description, one maximal
    // comment, one relation page floor, and per-field overhead: producers
    // shrink embedded pages to the measured remainder instead of failing.
    const {
      detailMaxUtf8Bytes,
      maxRequestDescriptionBytes,
      maxTicketBodyBytes,
      maxTicketCommentBytes,
    } = COLLAB_LIMITS;
    const worstJsonStringBytes = (bytes: number) => bytes * 6;
    const largestFixedPart = worstJsonStringBytes(
      Math.max(maxTicketBodyBytes, maxRequestDescriptionBytes),
    );
    expect(detailMaxUtf8Bytes - largestFixedPart - worstJsonStringBytes(maxTicketCommentBytes))
      .toBeGreaterThan(32 * 1024);
    expect(COLLAB_LIMITS.maxJsonPayloadUtf8Bytes - detailMaxUtf8Bytes)
      .toBeGreaterThanOrEqual(32 * 1024);
  });

  it('decodes request detail with a first comment page and no changedFiles', () => {
    const detail = collabControlOperationCodec('getRequest').decodeResponse({
      comments: {
        comments: [comment('comment-1', 'request-a')],
        nextCursor: 'cursor-1',
      },
      currentMainOid: MAIN,
      request: changeRequest({ commentCount: 3 }),
      reviewCondition: 'clean',
      reviewedHeadOid: HEAD,
    });

    expect(detail).toEqual({
      comments: {
        comments: [comment('comment-1', 'request-a')],
        nextCursor: 'cursor-1',
      },
      currentMainOid: MAIN,
      request: changeRequest({ commentCount: 3 }),
      reviewCondition: 'clean',
      reviewedHeadOid: HEAD,
    });
    expect(detail).not.toHaveProperty('changedFiles');
  });

  it('rejects a request detail that still carries changedFiles', () => {
    expect(() => collabControlOperationCodec('getRequest').decodeResponse({
      changedFiles: [],
      comments: { comments: [] },
      currentMainOid: MAIN,
      request: changeRequest(),
      reviewCondition: 'clean',
      reviewedHeadOid: HEAD,
    })).toThrow('collab.error.protocol-payload-invalid');
  });

  it('bounds detail comment pages by count and validates their cursors', () => {
    const oversizedPage = Array.from(
      { length: COLLAB_LIMITS.maxCommentPageSize + 1 },
      (_value, index) => comment(`comment-${index}`, 'request-a'),
    );
    expect(() => collabControlOperationCodec('getRequest').decodeResponse({
      comments: { comments: oversizedPage },
      currentMainOid: MAIN,
      request: changeRequest(),
      reviewCondition: 'clean',
      reviewedHeadOid: HEAD,
    })).toThrow('collab.error.protocol-payload-invalid');

    const oversizedCursor = 'c'.repeat(COLLAB_LIMITS.maxPageCursorUtf16 + 1);
    expect(() => collabControlOperationCodec('getRequest').decodeResponse({
      comments: { comments: [], nextCursor: oversizedCursor },
      currentMainOid: MAIN,
      request: changeRequest(),
      reviewCondition: 'clean',
      reviewedHeadOid: HEAD,
    })).toThrow('collab.error.protocol-payload-invalid');
  });

  it('rejects collection counts above the shared authority limits', () => {
    expect(() => collabControlOperationCodec('getRequest').decodeResponse({
      comments: { comments: [] },
      currentMainOid: MAIN,
      request: changeRequest({ commentCount: COLLAB_LIMITS.maxRequestComments + 1 }),
      reviewCondition: 'clean',
      reviewedHeadOid: HEAD,
    })).toThrow('collab.error.protocol-payload-invalid');

    for (const ticket of [
      ticketSummary({ commentCount: COLLAB_LIMITS.maxTicketComments + 1 }),
      ticketSummary({
        acceptedRelationCount: COLLAB_LIMITS.maxTicketAcceptedRelations + 1,
      }),
    ]) {
      expect(() => collabControlOperationCodec('getTicket').decodeResponse({
        acceptedRelations: { acceptedRelations: [] },
        body: 'Ticket body',
        comments: { comments: [] },
        ticket,
      })).toThrow('collab.error.protocol-payload-invalid');
    }
  });

  it('decodes paged list operations and rejects unknown or invalid fields', () => {
    for (const operation of [
      'listRequestComments',
      'listTicketComments',
      'listTicketAcceptedRelations',
    ] as const) {
      const idField = operation === 'listRequestComments' ? 'requestId' : 'ticketId';
      expect(collabControlOperationCodec(operation).decodeRequest({
        cursor: 'cursor-1',
        limit: 25,
        projectId: 'project-a',
        [idField]: 'opaque-id-1',
      })).toEqual({
        status: 'ok',
        value: {
          cursor: 'cursor-1',
          limit: 25,
          projectId: 'project-a',
          [idField]: 'opaque-id-1',
        },
      });
      expect(collabControlOperationCodec(operation).decodeRequest({
        projectId: 'project-a',
        [idField]: 'opaque-id-1',
      })).toEqual({
        status: 'ok',
        value: { projectId: 'project-a', [idField]: 'opaque-id-1' },
      });
      expect(collabControlOperationCodec(operation).decodeRequest({
        futureField: true,
        projectId: 'project-a',
        [idField]: 'opaque-id-1',
      }).status).toBe('invalid');
      expect(collabControlOperationCodec(operation).decodeRequest({
        cursor: 'c'.repeat(COLLAB_LIMITS.maxPageCursorUtf16 + 1),
        projectId: 'project-a',
        [idField]: 'opaque-id-1',
      }).status).toBe('invalid');
      expect(collabControlOperationCodec(operation).decodeRequest({
        limit: 0,
        projectId: 'project-a',
        [idField]: 'opaque-id-1',
      }).status).toBe('invalid');
      expect(collabControlOperationCodec(operation).decodeRequest({
        limit: COLLAB_LIMITS.maxCommentPageSize + 1,
        projectId: 'project-a',
        [idField]: 'opaque-id-1',
      }).status).toBe('invalid');
    }
    expect(COLLAB_CONTROL_OPERATION_CODECS).toHaveProperty('listRequestComments');
    expect(COLLAB_CONTROL_OPERATION_CODECS).toHaveProperty('listTicketComments');
    expect(COLLAB_CONTROL_OPERATION_CODECS).toHaveProperty('listTicketAcceptedRelations');
  });

  it('decodes paged list responses from specification literals', () => {
    expect(collabControlOperationCodec('listRequestComments').decodeResponse({
      comments: [comment('comment-1', 'request-a')],
      nextCursor: 'cursor-2',
    })).toEqual({
      comments: [comment('comment-1', 'request-a')],
      nextCursor: 'cursor-2',
    });

    expect(collabControlOperationCodec('listTicketComments').decodeResponse({
      comments: [ticketComment('ticket-comment-1', 'ticket-a')],
    })).toEqual({ comments: [ticketComment('ticket-comment-1', 'ticket-a')] });

    expect(collabControlOperationCodec('listTicketAcceptedRelations').decodeResponse({
      acceptedRelations: [acceptedRelation('relation-1')],
    })).toEqual({ acceptedRelations: [acceptedRelation('relation-1')] });

    const oversizedComments = Array.from(
      { length: COLLAB_LIMITS.maxCommentPageSize + 1 },
      (_value, index) => comment(`comment-${index}`, 'request-a'),
    );
    expect(() => collabControlOperationCodec('listRequestComments').decodeResponse({
      comments: oversizedComments,
    })).toThrow('collab.error.protocol-payload-invalid');

    const oversizedRelations = Array.from(
      { length: COLLAB_LIMITS.maxRelationsPerPage + 1 },
      (_value, index) => acceptedRelation(`relation-${index}`),
    );
    expect(() => collabControlOperationCodec('listTicketAcceptedRelations').decodeResponse({
      acceptedRelations: oversizedRelations,
    })).toThrow('collab.error.protocol-payload-invalid');
  });

  it('rejects pages that exceed their final JSON byte budgets after escaping', () => {
    const worstCaseRequestBody = '\u0000'.repeat(COLLAB_LIMITS.maxCommentBytes);
    const requestComments = [
      comment('comment-1', 'request-a', worstCaseRequestBody),
      comment('comment-2', 'request-a', worstCaseRequestBody),
    ];
    expect(new TextEncoder().encode(JSON.stringify({ comments: requestComments })).byteLength)
      .toBeGreaterThan(COLLAB_LIMITS.commentPageMaxUtf8Bytes);
    expect(() => collabControlOperationCodec('listRequestComments').decodeResponse({
      comments: requestComments,
    })).toThrow('collab.error.protocol-payload-invalid');

    const worstCaseTicketBody = '\u0000'.repeat(COLLAB_LIMITS.maxTicketCommentBytes);
    const ticketComments = [
      ticketComment('comment-1', 'ticket-a', worstCaseTicketBody),
      ticketComment('comment-2', 'ticket-a', worstCaseTicketBody),
    ];
    expect(new TextEncoder().encode(JSON.stringify({ comments: ticketComments })).byteLength)
      .toBeGreaterThan(COLLAB_LIMITS.commentPageMaxUtf8Bytes);
    expect(() => collabControlOperationCodec('listTicketComments').decodeResponse({
      comments: ticketComments,
    })).toThrow('collab.error.protocol-payload-invalid');

    const tickets = Array.from(
      { length: COLLAB_LIMITS.maxTicketPageSize },
      (_value, index) => ticketSummary({
        id: `ticket-${index}`,
        number: index + 1,
        title: '\u0000'.repeat(COLLAB_LIMITS.maxTicketTitleUtf16),
      }),
    );
    expect(new TextEncoder().encode(JSON.stringify({ tickets })).byteLength)
      .toBeGreaterThan(COLLAB_LIMITS.ticketPageMaxUtf8Bytes);
    expect(() => collabControlOperationCodec('listTickets').decodeResponse({ tickets }))
      .toThrow('collab.error.protocol-payload-invalid');
  });

  it('rejects detail payloads larger than the shared final JSON budget', () => {
    const oversizedDetail = {
      acceptedRelations: { acceptedRelations: [] },
      body: 'Body',
      comments: { comments: [] },
      ignoredFutureField: '\u0000'.repeat(COLLAB_LIMITS.detailMaxUtf8Bytes),
      ticket: ticketSummary(),
    };
    expect(new TextEncoder().encode(JSON.stringify(oversizedDetail)).byteLength)
      .toBeGreaterThan(COLLAB_LIMITS.detailMaxUtf8Bytes);
    expect(() => collabControlOperationCodec('getTicket').decodeResponse(oversizedDetail))
      .toThrow('collab.error.protocol-payload-invalid');
  });

  it('decodes ticket detail with first comment and relation pages', () => {
    const detail = collabControlOperationCodec('getTicket').decodeResponse({
      acceptedRelations: {
        acceptedRelations: [acceptedRelation('relation-1')],
      },
      body: 'Body',
      comments: { comments: [ticketComment('ticket-comment-1', 'ticket-a')] },
      ticket: ticketSummary(),
    });

    expect(detail).toEqual({
      acceptedRelations: {
        acceptedRelations: [acceptedRelation('relation-1')],
      },
      body: 'Body',
      comments: { comments: [ticketComment('ticket-comment-1', 'ticket-a')] },
      ticket: ticketSummary(),
    });
  });

  it('bounds ticket detail pages by count', () => {
    const oversizedRelations = Array.from(
      { length: COLLAB_LIMITS.maxRelationsPerPage + 1 },
      (_value, index) => acceptedRelation(`relation-${index}`),
    );
    expect(() => collabControlOperationCodec('getTicket').decodeResponse({
      acceptedRelations: { acceptedRelations: oversizedRelations },
      body: 'Body',
      comments: { comments: [] },
      ticket: ticketSummary(),
    })).toThrow('collab.error.protocol-payload-invalid');
  });
});
