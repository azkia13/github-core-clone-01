// The MCP endpoint (`POST /mcp`): JSON-RPC 2.0 over plain HTTP, modern era 2026-07-28
// (`server/discover`) with the legacy `initialize` handshake kept for a pre-discover client.
// Six tools, github-mcp-server's names, each answering `{content:[{type:'text', text: JSON}],
// structuredContent}` so the REST surface reads the same objects back. An unknown tool is
// JSON-RPC -32602, a missing required argument is a tool error (`isError: true`), a body that
// is not JSON is HTTP 400 with JSON-RPC -32700, and a request with no Authorization header is
// HTTP 401. Every request's `_meta` is ignored.

import { VIEWER, type Issue, type PullRequest, type Repo } from './store.ts';
import { isRecord } from './util.ts';

/** The server's identity, as `server/discover` and `initialize` both report it. */
export const MCP_SERVER_NAME = 'forge';
export const MCP_SERVER_VERSION = '1.0.0';
/** The modern revision this server speaks. */
export const MCP_REVISION = '2026-07-28';

/** The six tools, in a fixed order, byte-identical on every `tools/list`. */
export const MCP_TOOLS: readonly {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The repository owner (the authenticated user).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch.' },
        base: { type: 'string', description: 'The base branch.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash by default).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
        merge_method: { type: 'string', description: 'squash, merge or rebase.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** The store surface the tools need. */
export interface McpStore {
  getRepo(owner: string, name: string): Repo | undefined;
  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null;
  createIssue(repo: Repo, opts: { title: string; body: string; labels?: readonly string[] }): Issue | { error: string };
  createPull(repo: Repo, opts: { head: string; base: string; title: string; body: string }): PullRequest | { error: string };
  mergePull(repo: Repo, pull: PullRequest, method: 'squash' | 'merge' | 'rebase'): { sha: string } | { error: 'conflict' | 'already' };
}

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  readonly jsonrpc?: unknown;
  readonly id?: JsonRpcId;
  readonly method?: unknown;
  readonly params?: unknown;
}

/** A JSON-RPC result envelope. */
function resultEnvelope(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

/** A JSON-RPC error envelope. */
function errorEnvelope(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** A tool result: text plus the same object as structured content. */
function toolResult(value: Record<string, unknown>): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

/** A tool error result: `isError: true` with the reason as text. */
function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** The repository view a tool returns (the REST shape, trimmed). */
function repoToolView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueToolView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: issue.user.login, id: issue.user.id, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function pullToolView(repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.head.ref}`) ?? pull.head.sha;
  const baseSha = repo.refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head.ref, sha: headSha },
    base: { ref: pull.base.ref, sha: baseSha },
  };
}

/** The arguments of a tools/call, as a record (anything else is no arguments). */
function callArgs(params: unknown): Record<string, unknown> {
  if (!isRecord(params)) return {};
  const args = params.arguments;
  return isRecord(args) ? args : {};
}

/** A required string argument, or null when it is missing or not a string. */
function requiredString(args: Record<string, unknown>, name: string): string | null {
  const value = args[name];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Run one tool. Returns the tool result, or a JSON-RPC error code when the call itself is invalid. */
function runTool(
  store: McpStore,
  name: string,
  args: Record<string, unknown>,
): { result: Record<string, unknown> } | { rpcError: { code: number; message: string } } {
  switch (name) {
    case 'create_repo': {
      const repoName = requiredString(args, 'name');
      if (repoName === null) return { result: toolError('create_repo requires a name') };
      const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : VIEWER.login;
      const repo = store.createRepo(owner, repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
      if (repo === null) return { result: toolError(`Repository ${owner}/${repoName} already exists`) };
      return { result: toolResult(repoToolView(repo)) };
    }
    case 'get_repo': {
      const owner = requiredString(args, 'owner');
      const repoName = requiredString(args, 'repo');
      if (owner === null || repoName === null) return { result: toolError('get_repo requires owner and repo') };
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { result: toolError(`Repository ${owner}/${repoName} not found`) };
      return { result: toolResult(repoToolView(repo)) };
    }
    case 'create_issue': {
      const owner = requiredString(args, 'owner');
      const repoName = requiredString(args, 'repo');
      const title = requiredString(args, 'title');
      if (owner === null || repoName === null || title === null) {
        return { result: toolError('create_issue requires owner, repo and title') };
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { result: toolError(`Repository ${owner}/${repoName} not found`) };
      const created = store.createIssue(repo, { title, body: typeof args.body === 'string' ? args.body : '' });
      if ('error' in created) return { result: toolError(created.error) };
      return { result: toolResult(issueToolView(repo, created)) };
    }
    case 'list_issues': {
      const owner = requiredString(args, 'owner');
      const repoName = requiredString(args, 'repo');
      if (owner === null || repoName === null) return { result: toolError('list_issues requires owner and repo') };
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { result: toolError(`Repository ${owner}/${repoName} not found`) };
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const issues = state === 'all' ? repo.issues : repo.issues.filter((issue) => issue.state === state);
      const listed = issues.map((issue) => issueToolView(repo, issue));
      return { result: toolResult({ issues: listed, total_count: listed.length }) };
    }
    case 'create_pull_request': {
      const owner = requiredString(args, 'owner');
      const repoName = requiredString(args, 'repo');
      const title = requiredString(args, 'title');
      const head = requiredString(args, 'head');
      const base = requiredString(args, 'base');
      if (owner === null || repoName === null || title === null || head === null || base === null) {
        return { result: toolError('create_pull_request requires owner, repo, title, head and base') };
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { result: toolError(`Repository ${owner}/${repoName} not found`) };
      const created = store.createPull(repo, { head, base, title, body: typeof args.body === 'string' ? args.body : '' });
      if ('error' in created) return { result: toolError(created.error) };
      return { result: toolResult(pullToolView(repo, created)) };
    }
    case 'merge_pull_request': {
      const owner = requiredString(args, 'owner');
      const repoName = requiredString(args, 'repo');
      const numberRaw = args.pull_number;
      const number = typeof numberRaw === 'number' ? numberRaw : typeof numberRaw === 'string' ? Number(numberRaw) : Number.NaN;
      if (owner === null || repoName === null || !Number.isInteger(number)) {
        return { result: toolError('merge_pull_request requires owner, repo and pull_number') };
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { result: toolError(`Repository ${owner}/${repoName} not found`) };
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (pull === undefined) return { result: toolError(`Pull request #${number} not found`) };
      const methodRaw = typeof args.merge_method === 'string' ? args.merge_method.toLowerCase() : 'squash';
      const method = methodRaw === 'merge' ? 'merge' : methodRaw === 'rebase' ? 'rebase' : 'squash';
      const merged = store.mergePull(repo, pull, method);
      if ('error' in merged) {
        return { result: toolError(merged.error === 'conflict' ? 'the pull request has a merge conflict' : 'the pull request is not open') };
      }
      return { result: toolResult({ ...pullToolView(repo, pull), merged: true, sha: merged.sha }) };
    }
    default:
      return { rpcError: { code: -32602, message: `unknown tool ${JSON.stringify(name)}` } };
  }
}

/** The `server/discover` result: identity, capabilities and supported revisions. */
function discoverResult(): Record<string, unknown> {
  const serverInfo = { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
  return {
    protocolVersion: MCP_REVISION,
    supportedVersions: [MCP_REVISION],
    capabilities: { tools: {} },
    serverInfo,
    _meta: {
      'io.modelcontextprotocol/serverInfo': serverInfo,
      'io.modelcontextprotocol/protocolVersion': MCP_REVISION,
    },
  };
}

/** The `initialize` result, for a pre-discover client. */
function initializeResult(params: unknown): Record<string, unknown> {
  const requested = isRecord(params) && typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_REVISION;
  return {
    protocolVersion: requested,
    capabilities: { tools: {} },
    serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
  };
}

/**
 * Handle one JSON-RPC request object. Notifications (no `id`) answer nothing; a request answers
 * one envelope. `handleMcp` wraps this for HTTP.
 */
export function handleMcpRequest(store: McpStore, request: unknown): Record<string, unknown> | null {
  if (!isRecord(request)) return errorEnvelope(null, -32600, 'the request is not a JSON-RPC object');
  const method = typeof request.method === 'string' ? request.method : '';
  const id: JsonRpcId = request.id === undefined ? null : (request.id as JsonRpcId);
  const isNotification = request.id === undefined;
  const params = request.params;
  if (method === 'server/discover') {
    if (isNotification) return null;
    return resultEnvelope(id, discoverResult());
  }
  if (method === 'initialize') {
    if (isNotification) return null;
    return resultEnvelope(id, initializeResult(params));
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return null;
  }
  if (method === 'tools/list') {
    if (isNotification) return null;
    return resultEnvelope(id, { tools: MCP_TOOLS });
  }
  if (method === 'tools/call') {
    if (isNotification) return null;
    const name = isRecord(params) && typeof params.name === 'string' ? params.name : '';
    const outcome = runTool(store, name, callArgs(params));
    if ('rpcError' in outcome) return errorEnvelope(id, outcome.rpcError.code, outcome.rpcError.message);
    return resultEnvelope(id, outcome.result);
  }
  if (method === 'ping') {
    if (isNotification) return null;
    return resultEnvelope(id, {});
  }
  if (isNotification) return null;
  return errorEnvelope(id, -32601, `method not found: ${JSON.stringify(method)}`);
}

/** The id a malformed body still carries, extracted from its raw text (or null). */
function extractId(text: string): JsonRpcId {
  const match = /"id"\s*:\s*("([^"\\]|\\.)*"|-?\d+)/.exec(text);
  if (match === null) return null;
  const raw = match[1]!;
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return null;
    }
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Handle `POST /mcp`. `authorized` is false when the request carries no valid bearer token
 * (the caller answers 401 itself before calling this, or passes false to let this answer 401).
 * Answers a JSON-RPC envelope, or null for a notification. A body that is not JSON is HTTP 400
 * with JSON-RPC -32700.
 */
export function handleMcp(
  store: McpStore,
  rawBody: Buffer,
  authorized: boolean,
): { status: number; body: unknown } {
  if (!authorized) {
    return { status: 401, body: { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Requires authentication' } } };
  }
  const text = rawBody.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { status: 400, body: errorEnvelope(extractId(text), -32700, 'Parse error') };
  }
  if (Array.isArray(parsed)) {
    // A batch: one envelope per request, in order (notifications dropped).
    const out: Array<Record<string, unknown>> = [];
    for (const entry of parsed) {
      const answer = handleMcpRequest(store, entry);
      if (answer !== null) out.push(answer);
    }
    return { status: 200, body: out };
  }
  const answer = handleMcpRequest(store, parsed);
  return { status: 200, body: answer };
}
