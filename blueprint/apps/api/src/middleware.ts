/**
 * Request pipeline (Phase 14): request-id → auth → tenant context → handler,
 * with a global error boundary mapping to the OpenAPI ApiError shape.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractBearerToken, hashApiKey, Logger, UnauthorizedError } from '@ulip/runtime';
import type { AppContext } from './composer.ts';
import type { Handler, RequestContext } from './http.ts';
import { errorReply } from './http.ts';

/** A handler invoked with an AuthenticatedContext (structurally compatible). */
export type AuthedHandler = (ctx: RequestContext & { principal: AuthenticatedContext['principal']; log: Logger }) => Promise<void> | void;

export interface AuthenticatedContext extends RequestContext {
  principal: { userId: string; tenantId: string; role: string; email: string };
  log: Logger;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface Route {
  method: HttpMethod;
  segments: string[]; // ':name' = path parameter
  handler: Handler;
  public: boolean;
}

export class Router {
  /** @internal used by the pipeline to resolve route metadata */
  readonly routes: Route[] = [];

  /** Accepts both public and authenticated handlers (structurally compatible). */
  add(method: HttpMethod, pattern: string, handler: Handler | AuthedHandler, opts: { public?: boolean } = {}): void {
    this.routes.push({
      method,
      segments: pattern.split('/').filter((s) => s !== ''),
      handler: handler as Handler,
      public: opts.public ?? false,
    });
  }

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = path.split('/').filter((s) => s !== '');
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i]!;
        const actual = parts[i]!;
        if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(actual);
        else if (seg !== actual) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }
}

/** Resolves the principal from the Authorization header via the users table. */
export async function authenticate(
  app: AppContext,
  headers: IncomingMessage['headers'],
): Promise<AuthenticatedContext['principal']> {
  const token = extractBearerToken(headers.authorization);
  if (token === null || token === '') throw new UnauthorizedError('missing bearer token');
  const user = await app.users.findByApiKeyHash(hashApiKey(token));
  if (user === null) throw new UnauthorizedError('unknown api key');
  return { userId: user.id, tenantId: user.tenant_id, role: user.role, email: user.email };
}

/** Wraps a handler with request-id, logging, auth and the error boundary. */
export function pipeline(
  app: AppContext,
  router: Router,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
    const log = app.log.bind({ requestId });
    const url = new URL(req.url ?? '/', 'http://localhost');
    const started = Date.now();

    const decorated = req as unknown as { __body?: unknown };
    const ctxBase = {
      method: (req.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      body: decorated.__body,
      requestId,
      raw: req,
      res,
    } as unknown as RequestContext;

    res.setHeader('x-request-id', requestId);

    try {
      const matched = router.match(ctxBase.method, ctxBase.path);
      if (matched === null) {
        errorReply(ctxBase, 404, 'NOT_FOUND', `no route for ${ctxBase.method} ${ctxBase.path}`);
        return;
      }
      const route = router.routes.find((r) => r.handler === matched.handler)!;
      const ctxWithParams = Object.assign(ctxBase, { params: matched.params }) as RequestContext & {
        params: Record<string, string>;
      };
      let ctx: RequestContext | AuthenticatedContext = ctxWithParams;

      if (!route.public) {
        const principal = await authenticate(app, req.headers);
        ctx = Object.assign(ctxWithParams, { principal, log }) as AuthenticatedContext;
      } else {
        ctx = Object.assign(ctxWithParams, { log }) as RequestContext & { log: Logger };
      }

      await matched.handler(ctx);
      log.info('request', { method: ctxBase.method, path: ctxBase.path, status: res.statusCode, ms: Date.now() - started });
    } catch (err) {
      const isAuth = err instanceof UnauthorizedError;
      const status = isAuth ? 401 : 500;
      const code = isAuth ? 'UNAUTHORIZED' : 'INTERNAL';
      if (!isAuth) log.error('unhandled error', { path: ctxBase.path, error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) {
        errorReply(ctxBase, status, code, err instanceof Error ? err.message : 'internal error');
      } else {
        res.end();
      }
    }
  };
}
