// The forge's HTTP server: one router for every surface — /healthz (public), git smart HTTP,
// REST v3, GraphQL v4 and MCP. The bearer token (MAKEFUN_SHOP_TOKEN) guards git, REST,
// GraphQL and MCP; /healthz is public. A handler that throws never takes the process down:
// the router answers 500 and logs, and the server keeps serving (the suite's
// repo-survives-errors check proves exactly that).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  advertisementV0,
  advertisementV2,
  applyPush,
  fetchCached,
  fetchCacheStore,
  fetchV0Response,
  fetchV2Response,
  lsRefsResponse,
  parseFetchV0Args,
  parseFetchV2Args,
  parseLsRefsArgs,
  parsePushBody,
  planFetch,
  pushReportResponse,
} from './git-http.ts';
import { executeGraphQL, type GraphQLStoreFull } from './graphql.ts';
import { handleMcp, type McpStore } from './mcp.ts';
import { handleRest, isAuthorized, type RestStore } from './rest.ts';
import { store } from './store.ts';
import { headerOf, isRecord, readBody, sendError, sendJson, splitPath } from './util.ts';

/** What the server needs: the expected bearer token ('' means authentication is off). */
export interface ForgeOptions {
  readonly token: string;
}

/** The one store, adapted to each surface's interface (all four share the same Store). */
const restStore: RestStore = store;
const graphqlStore: GraphQLStoreFull = store as unknown as GraphQLStoreFull;
const mcpStore: McpStore = store;

/** The git content types, by service. */
const GIT_ADVERTISEMENT_TYPE: Record<string, string> = {
  'git-upload-pack': 'application/x-git-upload-pack-advertisement',
  'git-receive-pack': 'application/x-git-receive-pack-advertisement',
};
const GIT_RESULT_TYPE: Record<string, string> = {
  'git-upload-pack': 'application/x-git-upload-pack-result',
  'git-receive-pack': 'application/x-git-receive-pack-result',
};

/** Send a raw buffer with a content type (git answers are not JSON). */
function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

/** The git endpoints' repository lookup: 404 when the repository does not exist. */
function gitRepo(owner: string, name: string): ReturnType<typeof store.getRepo> {
  return store.getRepo(owner, name);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  // The URL is parsed once here; the handlers below take it instead of re-parsing it.
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    url = new URL('/', 'http://entry');
  }
  const path = url.pathname;
  const segments = splitPath(path);

  // The boot probe: public, no token.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // The MCP endpoint.
  if (method === 'POST' && path === '/mcp') {
    const raw = await readBody(req);
    const answer = handleMcp(mcpStore, raw, isAuthorized(req, token));
    if (answer.body === null) {
      res.writeHead(204);
      res.end();
      return;
    }
    sendJson(res, answer.status, answer.body);
    return;
  }

  // GraphQL v4.
  if (method === 'POST' && path === '/api/graphql') {
    if (!isAuthorized(req, token)) {
      sendError(res, 401, 'Requires authentication');
      return;
    }
    let raw: Buffer;
    try {
      raw = await readBody(req);
    } catch (err) {
      sendError(res, 400, (err as Error).message);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8')) as unknown;
    } catch {
      sendError(res, 400, 'Problems parsing JSON');
      return;
    }
    // One operation, or a batch (a JSON array of operations, answered in order).
    if (Array.isArray(parsed)) {
      const answers: Array<Record<string, unknown>> = [];
      for (const entry of parsed) {
        answers.push(executeOneGraphQL(entry));
      }
      sendJson(res, 200, answers);
      return;
    }
    sendJson(res, 200, executeOneGraphQL(parsed));
    return;
  }

  // REST v3.
  if (segments[0] === 'api' && segments[1] === 'v3') {
    await handleRest(req, res, restStore, token, url);
    return;
  }

  // Git smart HTTP: /{owner}/{repo}/info/refs and /{owner}/{repo}/git-upload-pack|git-receive-pack.
  // The git client addresses a repository as `{owner}/{repo}.git`, so the `.git` suffix is stripped.
  if (segments.length >= 2) {
    const owner = segments[0]!;
    const repoName = segments[1]!.replace(/\.git$/, '');
    const tail = segments.slice(2);
    if (tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs' && method === 'GET') {
      await handleInfoRefs(req, res, token, owner, repoName, url);
      return;
    }
    if (tail.length === 1 && (tail[0] === 'git-upload-pack' || tail[0] === 'git-receive-pack') && method === 'POST') {
      await handleGitService(req, res, token, owner, repoName, tail[0]);
      return;
    }
  }

  // Anything else: a JSON 404 (never HTML).
  sendError(res, 404, 'Not Found');
}

/** Execute one GraphQL operation object ({query, variables, operationName}). */
function executeOneGraphQL(entry: unknown): Record<string, unknown> {
  if (!isRecord(entry) || typeof entry.query !== 'string') {
    return { data: null, errors: [{ message: 'the request body is not a GraphQL operation' }] };
  }
  const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
  const operationName = typeof entry.operationName === 'string' ? entry.operationName : undefined;
  const result = executeGraphQL(graphqlStore, entry.query, variables, operationName);
  const out: Record<string, unknown> = { data: result.data };
  if (result.errors.length > 0) out.errors = result.errors;
  return out;
}

/** `GET /{owner}/{repo}/info/refs?service=...`: the ref/capability advertisement. */
async function handleInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  owner: string,
  repoName: string,
  url: URL,
): Promise<void> {
  if (!isAuthorized(req, token)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }
  const repo = gitRepo(owner, repoName);
  if (repo === undefined) {
    sendError(res, 404, `Repository ${owner}/${repoName} not found`);
    return;
  }
  const service = url.searchParams.get('service') ?? '';
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendError(res, 400, `unknown service ${JSON.stringify(service)}`);
    return;
  }
  const version = headerOf(req, 'git-protocol');
  if (service === 'git-upload-pack' && version === 'version=2') {
    sendBuffer(res, 200, GIT_ADVERTISEMENT_TYPE[service]!, advertisementV2());
    return;
  }
  sendBuffer(res, 200, GIT_ADVERTISEMENT_TYPE[service]!, advertisementV0(repo, service));
}

/** `POST /{owner}/{repo}/git-upload-pack` or `/git-receive-pack`. */
async function handleGitService(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  owner: string,
  repoName: string,
  service: 'git-upload-pack' | 'git-receive-pack',
): Promise<void> {
  if (!isAuthorized(req, token)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }
  const repo = gitRepo(owner, repoName);
  if (repo === undefined) {
    sendError(res, 404, `Repository ${owner}/${repoName} not found`);
    return;
  }
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch (err) {
    sendError(res, 400, (err as Error).message);
    return;
  }
  if (service === 'git-receive-pack') {
    let parsed;
    try {
      parsed = parsePushBody(body);
    } catch (err) {
      sendError(res, 400, (err as Error).message);
      return;
    }
    const result = applyPush(repo, parsed.commands, parsed.pack);
    sendBuffer(res, 200, GIT_RESULT_TYPE[service]!, pushReportResponse(result));
    return;
  }
  // upload-pack: v2 when the client asked for it, else v0.
  const version = headerOf(req, 'git-protocol');
  if (version === 'version=2') {
    // A v2 ls-refs command is a different request shape on the same endpoint.
    if (isLsRefsRequest(body)) {
      let lsArgs;
      try {
        lsArgs = parseLsRefsArgs(body);
      } catch (err) {
        sendError(res, 400, (err as Error).message);
        return;
      }
      sendBuffer(res, 200, GIT_RESULT_TYPE[service]!, lsRefsResponse(repo, lsArgs));
      return;
    }
    let args;
    try {
      args = parseFetchV2Args(body);
    } catch (err) {
      sendError(res, 400, (err as Error).message);
      return;
    }
    const cached = fetchCached(repo, 'v2', args);
    if (cached !== null) {
      sendBuffer(res, 200, GIT_RESULT_TYPE[service]!, cached);
      return;
    }
    const plan = planFetch(repo, args);
    const answer = fetchV2Response(repo, args, plan);
    fetchCacheStore(repo, 'v2', args, answer);
    sendBuffer(res, 200, GIT_RESULT_TYPE[service]!, answer);
    return;
  }
  let args;
  try {
    args = parseFetchV0Args(body);
  } catch (err) {
    sendError(res, 400, (err as Error).message);
    return;
  }
  const cached = fetchCached(repo, 'v0', args);
  if (cached !== null) {
    sendBuffer(res, 200, GIT_RESULT_TYPE[service]!, cached);
    return;
  }
  const plan = planFetch(repo, args);
  const answer = fetchV0Response(repo, args, plan);
  fetchCacheStore(repo, 'v0', args, answer);
  sendBuffer(res, 200, GIT_RESULT_TYPE[service]!, answer);
}

/** Whether a v2 upload-pack body is an ls-refs command (its first line is `command=ls-refs`). */
function isLsRefsRequest(body: Buffer): boolean {
  const text = body.toString('utf8', 0, Math.min(body.length, 64));
  return text.includes('command=ls-refs');
}

/** Build the server. The caller listens on it (main.ts binds port 0 in trial mode). */
export function createForgeServer(options: ForgeOptions): Server {
  const token = options.token;
  const server = createServer((req, res) => {
    void handleRequest(req, res, token).catch((err) => {
      console.error('request failed:', err instanceof Error ? err.message : String(err));
      try {
        if (!res.headersSent) sendError(res, 500, 'internal error');
        else res.end();
      } catch {
        // The socket is already gone; nothing more to do.
      }
    });
  });
  return server;
}

/**
 * Build the server the way the entrypoint does: the bearer token comes from MAKEFUN_SHOP_TOKEN
 * (empty means authentication is off, for a local practice run).
 */
export function createApp(): Server {
  return createForgeServer({ token: process.env.MAKEFUN_SHOP_TOKEN ?? '' });
}
