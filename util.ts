// util.ts — small HTTP helpers shared by every surface.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

/** A unique-ish request id for the X-GitHub-Request-Id header (a counter is enough). */
export function newRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** Answer with a JSON body (or an empty 204). */
export function sendJson(res: ServerResponse, status: number, body: unknown, extra: Readonly<Record<string, string>> = {}): void {
  if (status === 204) {
    res.writeHead(204, { 'x-github-request-id': newRequestId(), ...extra });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': newRequestId(),
    ...extra,
  });
  res.end(text);
}

/** Answer with raw bytes and an explicit content type. */
export function sendBuffer(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  extra: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': newRequestId(),
    ...extra,
  });
  res.end(body);
}

/** Read a whole request body (cap 128 MiB — packs are at most a few MB). */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 128 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export type JsonParse = { ok: true; value: unknown } | { ok: false };

/** Parse a request body as JSON. Empty bodies parse as undefined. */
export function parseJsonBody(buf: Buffer): JsonParse {
  const text = buf.toString('utf8').trim();
  if (text === '') return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** The request path, or '/' when it does not parse. */
export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** The request query parameters. */
export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Decode one path segment (a name, never a whole path). */
export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Whether the request carries a non-empty Bearer token. */
export function hasBearer(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(\S+)$/.exec(header);
  return match !== null && (match[1] ?? '') !== '';
}
