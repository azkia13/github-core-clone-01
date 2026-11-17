// Shared HTTP and JSON helpers for the forge. Node built-ins only, no dependencies.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** A monotonically increasing request counter: the X-GitHub-Request-Id values. */
let requestCounter = 0;

/** The next request id: deterministic per process (`req-1`, `req-2`, ...). */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** Answer with a JSON body. Always sets Content-Length and the request-id header. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

/** Answer with a GitHub-shaped error body: `{"message": "..."}`. */
export function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  sendJson(res, status, { message }, headers);
}

/** Answer with no body (204). Still carries the request-id header. */
export function sendNoContent(res: ServerResponse, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(204, { 'x-github-request-id': nextRequestId(), ...headers });
  res.end();
}

/** The path of a request URL, or '/' when it does not parse (never a throw). */
export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** The query parameters of a request URL (an empty map when it does not parse). */
export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** The value of one request header, or null. */
export function headerOf(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

/** Read a request body, up to `maxBytes` (default 64 MiB). Throws on overflow. */
export async function readBody(req: IncomingMessage, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) throw new Error('request body is too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

/** Parse a body as JSON. Returns undefined for an empty body; throws on invalid JSON. */
export function parseJsonBody(body: Buffer): unknown {
  const text = body.toString('utf8').trim();
  if (text === '') return undefined;
  return JSON.parse(text) as unknown;
}

/** Standard base64 of UTF-8 text. */
export function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Decode base64, ignoring whitespace (GitHub wraps contents base64 at 60 columns). */
export function b64decode(content: string): string {
  return Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64').toString('utf8');
}

/** Decode base64 to bytes, ignoring whitespace. */
export function b64ToBuffer(content: string): Buffer {
  return Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
}

/** Whether `value` is a plain JSON object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A value as a string, or '' when it is not one. */
export function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A value as a number, or NaN when it is not one. */
export function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number.NaN;
}

/** A value as a boolean, or undefined when it is not one. */
export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Whether `name` is a usable repository/owner name (GitHub's shape, as the suite's client checks). */
export function isValidName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) && !name.endsWith('.git');
}

/** Split a path into its segments, dropping empty ones. */
export function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/** Whether a ref name is usable (`refs/...`, no whitespace or control characters). */
export function isValidRef(ref: string): boolean {
  return ref.startsWith('refs/') && ref.length <= 200 && !/[\s\u0000-\u001f]/.test(ref);
}

/** ISO-8601 now. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Unix seconds now. */
export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
