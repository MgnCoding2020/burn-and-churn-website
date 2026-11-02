import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * RFC 9457 problem details: the one error shape every /api response uses.
 * Never put stack traces, SQL, or upstream error text in `detail`.
 */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  requestId?: string;
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export function problemBody(
  status: ContentfulStatusCode,
  title: string,
  detail?: string,
  requestId?: string,
): Problem {
  return {
    type: 'about:blank',
    title,
    status,
    ...(detail ? { detail } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

export function problem(
  c: Context,
  status: ContentfulStatusCode,
  title: string,
  detail?: string,
): Response {
  const requestId = c.get('requestId') as string | undefined;
  return c.body(JSON.stringify(problemBody(status, title, detail, requestId)), status, {
    'Content-Type': PROBLEM_CONTENT_TYPE,
  });
}
