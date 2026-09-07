import type { CollabControlRouteRequest } from '@/app/collab/lan/routes/RouteTypes';
import { CollabError } from '@/core/collab/ClaudianCollabError';

function routeError(reason: string): CollabError {
  return new CollabError({
    code: 'protocol-payload-invalid',
    safeContext: { reason },
  });
}

/**
 * Parse the wire `cursor`/`limit` query pair for paged GET routes. Upper
 * bounds are enforced by the shared operation request codecs downstream.
 */
export function decodeRoutePageQuery(
  request: CollabControlRouteRequest,
  reason: string,
): { readonly cursor?: string; readonly limit?: number } {
  if (Object.keys(request.query).some(field => field !== 'cursor' && field !== 'limit')) {
    throw routeError(reason);
  }
  const limitValue = request.query.limit;
  const limit = limitValue === undefined ? undefined : Number(limitValue);
  if (
    limit !== undefined
    && (!/^\d+$/u.test(limitValue ?? '') || !Number.isSafeInteger(limit) || limit < 1)
  ) {
    throw routeError(reason);
  }
  return {
    ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}
