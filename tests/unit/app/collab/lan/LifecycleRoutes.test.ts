import {
  LAN_COLLAB_LIFECYCLE_CONTROL_OPERATIONS,
  type LanCollabLifecycleControlOperation as CollabLifecycleControlOperation,
} from '@/app/collab/lan/LanCollabControlOperations';
import {
  handleLifecycleRoute,
  isLifecycleControlRoute,
} from '@/app/collab/lan/routes/LifecycleRoutes';
import type {
  CollabControlRouteRequest,
} from '@/app/collab/lan/routes/RouteTypes';

const CREDENTIAL = 'A'.repeat(43);
const PROJECT_ID = 'project-a';
const IDEMPOTENCY_KEY = 'operation-key';
const OFFER_ID = 'offer-a';
const TRANSFER_ID = 'transfer-a';

interface RouteCase {
  readonly body: Readonly<Record<string, unknown>>;
  readonly method: string;
  readonly operation: CollabLifecycleControlOperation;
  readonly segments: readonly string[];
  readonly expectedRequest: Readonly<Record<string, unknown>>;
}

const mutation = (body: Readonly<Record<string, unknown>>) => ({
  idempotencyKey: IDEMPOTENCY_KEY,
  projectId: PROJECT_ID,
  ...body,
});

const cases: readonly RouteCase[] = [
  {
    body: mutation({
      expectedHostMemberId: 'member-host',
      expectedMemberId: 'member-a',
      idempotencyManagerMemberId: null,
      managerResponsibilityOfferId: OFFER_ID,
    }),
    expectedRequest: mutation({
      expectedHostMemberId: 'member-host',
      expectedMemberId: 'member-a',
      idempotencyManagerMemberId: null,
      managerResponsibilityOfferId: OFFER_ID,
    }),
    method: 'POST', operation: 'leaveProject', segments: ['leave'],
  },
  {
    body: mutation({
      purpose: 'manager-leave',
      targetMemberId: 'member-a',
    }),
    expectedRequest: mutation({
      purpose: 'manager-leave',
      targetMemberId: 'member-a',
    }),
    method: 'POST', operation: 'createManagerResponsibilityOffer',
    segments: ['manager-responsibility-offers'],
  },
  {
    body: {}, expectedRequest: { projectId: PROJECT_ID }, method: 'GET',
    operation: 'getCurrentManagerResponsibilityOffer',
    segments: ['manager-responsibility-offers', 'current'],
  },
  {
    body: {}, expectedRequest: { offerId: OFFER_ID, projectId: PROJECT_ID }, method: 'GET',
    operation: 'getManagerResponsibilityOffer',
    segments: ['manager-responsibility-offers', OFFER_ID],
  },
  {
    body: mutation({ expectedTargetMemberId: 'member-a', offerId: OFFER_ID }),
    expectedRequest: mutation({ expectedTargetMemberId: 'member-a', offerId: OFFER_ID }),
    method: 'POST', operation: 'acknowledgeManagerResponsibility',
    segments: ['manager-responsibility-offers', OFFER_ID, 'acknowledge'],
  },
  {
    body: mutation({ expectedTargetMemberId: 'member-a', offerId: OFFER_ID }),
    expectedRequest: mutation({ expectedTargetMemberId: 'member-a', offerId: OFFER_ID }),
    method: 'POST', operation: 'declineManagerResponsibility',
    segments: ['manager-responsibility-offers', OFFER_ID, 'decline'],
  },
  {
    body: mutation({ offerId: OFFER_ID }),
    expectedRequest: mutation({ offerId: OFFER_ID }),
    method: 'DELETE', operation: 'cancelManagerResponsibilityOffer',
    segments: ['manager-responsibility-offers', OFFER_ID],
  },
  {
    body: mutation({
      managerResponsibilityOfferId: OFFER_ID,
      targetMemberId: 'member-a',
    }),
    expectedRequest: mutation({
      managerResponsibilityOfferId: OFFER_ID,
      targetMemberId: 'member-a',
    }),
    method: 'POST', operation: 'promoteManager',
    segments: ['managers', 'member-a', 'promote'],
  },
  {
    body: mutation({ targetMemberId: 'member-a' }),
    expectedRequest: mutation({ targetMemberId: 'member-a' }),
    method: 'POST', operation: 'demoteManager',
    segments: ['managers', 'member-a', 'demote'],
  },
  {
    body: mutation({ expectedHostMemberId: 'member-host', targetMemberId: 'member-a' }),
    expectedRequest: mutation({ expectedHostMemberId: 'member-host', targetMemberId: 'member-a' }),
    method: 'POST', operation: 'createHostTransfer', segments: ['host-transfers'],
  },
  {
    body: mutation({
      receiverCredential: 'B'.repeat(43),
      targetCaCertificatePem: '-----BEGIN CERTIFICATE-----\nQQ==\n-----END CERTIFICATE-----\n',
      targetCaFingerprint: 'ab'.repeat(32),
      targetEndpoint: 'https://192.168.1.12:4545',
      transferId: TRANSFER_ID,
    }),
    expectedRequest: mutation({
      receiverCredential: 'B'.repeat(43),
      targetCaCertificatePem: '-----BEGIN CERTIFICATE-----\nQQ==\n-----END CERTIFICATE-----\n',
      targetCaFingerprint: 'ab'.repeat(32),
      targetEndpoint: 'https://192.168.1.12:4545',
      transferId: TRANSFER_ID,
    }),
    method: 'POST', operation: 'acceptHostTransfer',
    segments: ['host-transfers', TRANSFER_ID, 'accept'],
  },
  {
    body: mutation({ expectedTargetMemberId: 'member-a', transferId: TRANSFER_ID }),
    expectedRequest: mutation({ expectedTargetMemberId: 'member-a', transferId: TRANSFER_ID }),
    method: 'POST', operation: 'declineHostTransfer',
    segments: ['host-transfers', TRANSFER_ID, 'decline'],
  },
  {
    body: mutation({ expectedHostMemberId: 'member-host', transferId: TRANSFER_ID }),
    expectedRequest: mutation({ expectedHostMemberId: 'member-host', transferId: TRANSFER_ID }),
    method: 'DELETE', operation: 'cancelHostTransfer',
    segments: ['host-transfers', TRANSFER_ID],
  },
  {
    body: mutation({
      expectedHostMemberId: 'member-host', managerActorMemberId: 'member-manager',
    }),
    expectedRequest: mutation({
      expectedHostMemberId: 'member-host', managerActorMemberId: 'member-manager',
    }),
    method: 'POST', operation: 'retireProject', segments: ['retire'],
  },
  {
    body: mutation({ retiredAt: '2026-08-13T00:00:00.000Z' }),
    expectedRequest: mutation({ retiredAt: '2026-08-13T00:00:00.000Z' }),
    method: 'POST', operation: 'acknowledgeRetirement',
    segments: ['retirement', 'acknowledgements', 'current'],
  },
];

function route(
  testCase: RouteCase,
  overrides: Partial<CollabControlRouteRequest> = {},
): CollabControlRouteRequest {
  const lifecycle = {
    execute: jest.fn().mockResolvedValue({ data: { operation: testCase.operation } }),
  };
  return {
    authorization: `Bearer ${CREDENTIAL}`,
    body: testCase.body,
    idempotencyKey: testCase.method === 'GET' ? null : IDEMPOTENCY_KEY,
    lifecycle,
    method: testCase.method,
    projectId: PROJECT_ID,
    query: {},
    remoteAddress: '192.168.1.20',
    segments: testCase.segments,
    service: {} as never,
    ...overrides,
  };
}

describe('handleLifecycleRoute', () => {
  it('covers the complete v7 lifecycle operation inventory', () => {
    expect([
      ...cases.map(testCase => testCase.operation),
      'getHostTransitions',
    ]).toEqual(LAN_COLLAB_LIFECYCLE_CONTROL_OPERATIONS);
  });

  it.each(cases)('dispatches $operation with the exact v7 contract', async testCase => {
    const request = route(testCase);

    await expect(handleLifecycleRoute(request)).resolves.toEqual({
      data: { operation: testCase.operation },
    });
    expect(request.lifecycle?.execute).toHaveBeenCalledWith({
      credential: CREDENTIAL,
      operation: testCase.operation,
      request: testCase.expectedRequest,
    });
  });

  it('serves Host transition proofs without a Member credential', async () => {
    const execute = jest.fn().mockResolvedValue({
      data: { projectId: PROJECT_ID, proofs: [] },
    });
    const request = route(cases[0], {
      authorization: null,
      body: {},
      idempotencyKey: null,
      method: 'GET',
      segments: ['host-transitions'],
      lifecycle: { execute },
    });

    await expect(handleLifecycleRoute(request)).resolves.toEqual({
      data: { projectId: PROJECT_ID, proofs: [] },
    });
    expect(execute).toHaveBeenCalledWith({
      credential: null,
      operation: 'getHostTransitions',
      request: { projectId: PROJECT_ID },
    });
  });

  it('propagates retirement cleanup only as an app-internal post-flush callback', async () => {
    const afterResponseFlushed = jest.fn();
    const response = {
      acknowledgedAt: '2026-08-13T00:01:00.000Z',
      projectId: PROJECT_ID,
      retiredAt: '2026-08-13T00:00:00.000Z',
    };
    const execute = jest.fn().mockResolvedValue({
      afterResponseFlushed,
      data: response,
    });
    const request = route(cases.find(testCase => (
      testCase.operation === 'acknowledgeRetirement'
    ))!, {
      lifecycle: { execute },
    });

    await expect(handleLifecycleRoute(request)).resolves.toEqual({
      afterResponseFlushed,
      data: response,
    });
    expect(afterResponseFlushed).not.toHaveBeenCalled();
  });

  it('propagates Host-transfer cutover only as an app-internal post-flush callback', async () => {
    const afterResponseFlushed = jest.fn();
    const afterResponseSettled = jest.fn();
    const response = { operation: 'acceptHostTransfer' };
    const execute = jest.fn().mockResolvedValue({
      afterResponseFlushed,
      afterResponseSettled,
      data: response,
    });
    const request = route(cases.find(testCase => (
      testCase.operation === 'acceptHostTransfer'
    ))!, {
      lifecycle: { execute },
    });

    await expect(handleLifecycleRoute(request)).resolves.toEqual({
      afterResponseFlushed,
      afterResponseSettled,
      data: response,
    });
    expect(afterResponseFlushed).not.toHaveBeenCalled();
    expect(afterResponseSettled).not.toHaveBeenCalled();
  });

  it.each(cases)(
    'rejects missing credentials for $operation',
    async testCase => {
      await expect(handleLifecycleRoute(route(testCase, { authorization: null })))
        .rejects.toMatchObject({ code: 'authentication-failed' });
    },
  );

  it.each(cases.filter(testCase => testCase.method !== 'GET'))(
    'rejects body/header idempotency mismatch for $operation',
    async testCase => {
      await expect(handleLifecycleRoute(route(testCase, { idempotencyKey: 'other-key' })))
        .rejects.toMatchObject({ code: 'protocol-payload-invalid' });
    },
  );

  it('rejects a path/body identifier mismatch before service dispatch', async () => {
    const request = route(cases[4], {
      body: mutation({ expectedTargetMemberId: 'member-a', offerId: 'offer-other' }),
    });

    await expect(handleLifecycleRoute(request)).rejects.toMatchObject({
      code: 'protocol-payload-invalid',
    });
    expect(request.lifecycle?.execute).not.toHaveBeenCalled();
  });

  it('rejects a Manager path/body target mismatch before service dispatch', async () => {
    const promotion = cases.find(testCase => testCase.operation === 'promoteManager')!;
    const request = route(promotion, {
      body: mutation({
        managerResponsibilityOfferId: OFFER_ID,
        targetMemberId: 'member-other',
      }),
    });

    await expect(handleLifecycleRoute(request)).rejects.toMatchObject({
      code: 'protocol-payload-invalid',
    });
    expect(request.lifecycle?.execute).not.toHaveBeenCalled();
  });

  it('exposes exact lifecycle classification so the Router can reject old versions', () => {
    for (const testCase of cases) {
      expect(isLifecycleControlRoute(testCase.method, testCase.segments)).toBe(true);
    }
    expect(isLifecycleControlRoute('GET', ['host-transitions'])).toBe(true);
    expect(isLifecycleControlRoute('POST', ['leave', 'extra'])).toBe(false);
    expect(isLifecycleControlRoute('POST', ['manager-transfer'])).toBe(false);
    expect(isLifecycleControlRoute('DELETE', ['retire'])).toBe(false);
  });
});
