/**
 * Minimal HTTP primitives for the Phase 14 API foundation.
 *
 * The runtime foundation uses Node's http module directly — no web framework
 * yet — so the composition root stays explicit and auditable. Controllers
 * contain NO domain logic; they parse/validate and delegate.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RequestContext {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: unknown;
  requestId: string;
  raw: IncomingMessage;
  res: ServerResponse;
}

export type Handler = (ctx: RequestContext) => Promise<void> | void;

export function jsonReply(ctx: RequestContext, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  ctx.res.statusCode = status;
  ctx.res.setHeader('content-type', 'application/json; charset=utf-8');
  ctx.res.setHeader('x-request-id', ctx.requestId);
  ctx.res.end(body);
}

export function errorReply(
  ctx: RequestContext,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  jsonReply(ctx, status, {
    error: { code, message, ...(details !== undefined ? { details } : {}) },
    requestId: ctx.requestId,
  });
}

export async function readJsonBody(req: IncomingMessage, limitBytes = 1_048_576): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return undefined;
  return JSON.parse(raw) as unknown;
}

export function readQuery(req: IncomingMessage): URLSearchParams {
  const url = req.url ?? '/';
  const idx = url.indexOf('?');
  return new URLSearchParams(idx >= 0 ? url.slice(idx + 1) : '');
}
