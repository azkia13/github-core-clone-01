// The REST v3 surface (`/api/v3`): repositories, branches, commits, contents, labels, issues,
// pull requests and git refs. One bearer token is the viewer's; a repository under another
// login is 404 (never 403); a request with no token is 401. Every reply is JSON and carries
// X-GitHub-Request-Id, including errors (`{"message": ...}`).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isObjectId, parseCommit, parseTree } from './git-core.ts';
import {
  VIEWER,
  type FileChange,
  type Issue,
  type IssueComment,
  type Label,
  type PullRequest,
  type Repo,
} from './store.ts';
import {
  asBoolean,
  asString,
  b64ToBuffer,
  b64encode,
  headerOf,
  isRecord,
  isValidName,
  isValidRef,
  nowIso,
  parseJsonBody,
  readBody,
  sendError,
  sendJson,
  sendNoContent,
  splitPath,
} from './util.ts';

/** The context every REST handler receives. */
export interface RestContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  /** The path segments after `/api/v3`. */
  readonly segments: string[];
  readonly query: URLSearchParams;
  /** The parsed JSON body (undefined when the body is empty). */
  readonly body: unknown;
  /** The request's origin (`http://host`), for absolute Link headers. */
  readonly origin: string;
  /** The expected bearer token (MAKEFUN_SHOP_TOKEN); empty means any token is accepted. */
  readonly token: string;
}

/** Whether the request carries the expected bearer token. When no token is configured (the trial
 * runs with an empty MAKEFUN_SHOP_TOKEN, or a local dev run), authentication is off and every
 * request is accepted; otherwise the header must be exactly `Bearer <token>`. */
export function isAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  if (expectedToken === '') return true;
  const header = headerOf(req, 'authorization');
  if (header === null) return false;
  const match = /^Bearer (.+)$/.exec(header.trim());
  if (match === null) return false;
  return match[1] === expectedToken;
}

/** The origin of the request, from its Host header. */
export function originOf(req: IncomingMessage): string {
  const host = headerOf(req, 'host') ?? '127.0.0.1';
  return `http://${host}`;
}

// ---------------------------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------------------------

function userView(user: { id: number; login: string; name: string; email: string }): Record<string, unknown> {
  // Every user the store ever names is the viewer, so one shared view object is enough;
  // a different login still builds its own.
  if (user.login === VIEWER.login) return VIEWER_VIEW;
  return { login: user.login, id: user.id, name: user.name, email: user.email, type: 'User' };
}

/** The viewer's user object, shared by every view (views are only ever serialized). */
const VIEWER_VIEW: Record<string, unknown> = {
  login: VIEWER.login,
  id: VIEWER.id,
  name: VIEWER.name,
  email: VIEWER.email,
  type: 'User',
};

function repoView(repo: Repo, origin: string): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: userView(VIEWER),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `${origin}/${repo.fullName}`,
    url: `${origin}/api/v3/repos/${repo.fullName}`,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

function labelView(label: Label): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, description: label.description };
}

function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label !== undefined ? labelView(label) : { name };
    }),
    user: userView(issue.user),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.comments.length,
  };
}

function commentView(comment: Issue['comments'][number]): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: userView(comment.user),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

function pullView(repo: Repo, pull: PullRequest): Record<string, unknown> {
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
    head: { ref: pull.head.ref, sha: headSha, label: `${repo.owner}:${pull.head.ref}` },
    base: { ref: pull.base.ref, sha: baseSha, label: `${repo.owner}:${pull.base.ref}` },
    user: userView(pull.user),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

/** Parse a commit identity line (`Name <email> 1700000000 +0000`) into its parts. */
function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: nowIso() };
  return { name: match[1] ?? '', email: match[2] ?? '', date: new Date(Number(match[3]) * 1000).toISOString() };
}

function commitView(sha: string, data: Buffer): Record<string, unknown> {
  const commit = parseCommit(data);
  return {
    sha,
    commit: {
      message: commit.message,
      author: parseIdentity(commit.author),
      committer: parseIdentity(commit.committer),
      tree: { sha: commit.tree },
    },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

// ---------------------------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------------------------

interface PageParams {
  readonly page: number;
  readonly perPage: number;
}

/** The page parameters of a request (`per_page` 1..100, default 30; `page` >= 1, default 1). */
function pageParams(query: URLSearchParams): PageParams {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const pageRaw = Number(query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.floor(perPageRaw))) : 30;
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.floor(pageRaw)) : 1;
  return { page, perPage };
}

/** One page of `items`, plus the Link header when another page follows. */
function paginate<T>(items: readonly T[], params: PageParams, baseUrl: string): { page: T[]; link: string | null } {
  const start = (params.page - 1) * params.perPage;
  const page = items.slice(start, start + params.perPage);
  const lastPage = Math.max(1, Math.ceil(items.length / params.perPage));
  if (params.page >= lastPage) return { page, link: null };
  const next = `${baseUrl}?per_page=${params.perPage}&page=${params.page + 1}`;
  const last = `${baseUrl}?per_page=${params.perPage}&page=${lastPage}`;
  return { page, link: `<${next}>; rel="next", <${last}>; rel="last"` };
}

/** The Link header value, or an empty object when there is none. */
function linkHeader(link: string | null): Record<string, string> {
  return link === null ? {} : { link };
}

// ---------------------------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------------------------

/** The store handle the handlers use (the one Store, passed in by the router). */
export interface RestStore {
  getRepo(owner: string, name: string): Repo | undefined;
  listReposByOwner(owner: string): Repo[];
  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null;
  deleteRepo(owner: string, name: string): boolean;
  commitFile(
    repo: Repo,
    opts: { branch: string; path: string; content: Buffer; message: string; sha?: string },
  ): { commitSha: string; contentSha: string } | { error: string };
  deleteFile(
    repo: Repo,
    opts: { branch: string; path: string; message: string; sha?: string },
  ): { commitSha: string } | { error: string };
  createLabel(repo: Repo, name: string, color: string, description?: string): Label | null;
  createIssue(
    repo: Repo,
    opts: { title: string; body: string; labels?: readonly string[] },
  ): Issue | { error: string };
  addComment(repo: Repo, issue: Issue, body: string): IssueComment;
  createPull(
    repo: Repo,
    opts: { head: string; base: string; title: string; body: string },
  ): PullRequest | { error: string };
  mergePull(
    repo: Repo,
    pull: PullRequest,
    method: 'squash' | 'merge' | 'rebase',
  ): { sha: string } | { error: 'conflict' | 'already' };
  diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): FileChange[];
  branchTip(repo: Repo, branch: string): string | undefined;
}

type Handler = (ctx: RestContext, store: RestStore, params: Record<string, string>) => void | Promise<void>;

/** A route: a method, a pattern of segments (`:name` captures one segment, `*` the rest), a handler. */
interface Route {
  readonly method: string;
  readonly pattern: string[];
  readonly handler: Handler;
}

const routes: Route[] = [];

function route(method: string, pattern: string, handler: Handler): void {
  routes.push({ method, pattern: splitPath(pattern), handler });
}

/** Match a pattern against segments; captures `:name` and `*` (the rest, joined with '/'). */
function matchRoute(pattern: readonly string[], segments: readonly string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  let index = 0;
  for (const part of pattern) {
    if (part === '*') {
      params['*'] = segments.slice(index).join('/');
      return params;
    }
    if (index >= segments.length) return null;
    const segment = segments[index]!;
    if (part.startsWith(':')) params[part.slice(1)] = segment;
    else if (part !== segment) return null;
    index += 1;
  }
  return index === segments.length ? params : null;
}

// ---------------------------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------------------------

function requireRepo(ctx: RestContext, store: RestStore, owner: string, name: string): Repo | null {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) {
    sendError(ctx.res, 404, `Repository ${owner}/${name} not found`);
    return null;
  }
  return repo;
}

route('GET', '/', (ctx) => {
  sendJson(ctx.res, 200, {}, { 'x-oauth-scopes': 'repo, user, gist' });
});

route('GET', '/meta', (ctx) => {
  sendJson(ctx.res, 200, { installed_version: '1.0.0' });
});

route('GET', '/user', (ctx) => {
  sendJson(ctx.res, 200, userView(VIEWER));
});

route('GET', '/user/repos', (ctx, store) => {
  const params = pageParams(ctx.query);
  const repos = store.listReposByOwner(VIEWER.login);
  const baseUrl = `${ctx.origin}/api/v3/user/repos`;
  const { page, link } = paginate(repos, params, baseUrl);
  sendJson(ctx.res, 200, page.map((repo) => repoView(repo, ctx.origin)), linkHeader(link));
});

route('POST', '/user/repos', (ctx, store) => {
  const body = isRecord(ctx.body) ? ctx.body : {};
  const name = asString(body.name);
  if (!isValidName(name)) {
    sendError(ctx.res, 422, 'name is invalid');
    return;
  }
  const repo = store.createRepo(
    VIEWER.login,
    name,
    asString(body.description),
    asBoolean(body.private) ?? false,
  );
  if (repo === null) {
    sendError(ctx.res, 422, 'Repository already exists');
    return;
  }
  sendJson(ctx.res, 201, repoView(repo, ctx.origin));
});

route('GET', '/repos/:owner/:repo', (ctx, store, params) => {
  const repo = requireRepo(ctx, store, params.owner!, params.repo!);
  if (repo === null) return;
  sendJson(ctx.res, 200, repoView(repo, ctx.origin));
});

route('PATCH', '/repos/:owner/:repo', (ctx, store, params) => {
  const repo = requireRepo(ctx, store, params.owner!, params.repo!);
  if (repo === null) return;
  const body = isRecord(ctx.body) ? ctx.body : {};
  if (typeof body.description === 'string') repo.description = body.description;
  sendJson(ctx.res, 200, repoView(repo, ctx.origin));
});

route('DELETE', '/repos/:owner/:repo', (ctx, store, params) => {
  const repo = requireRepo(ctx, store, params.owner!, params.repo!);
  if (repo === null) return;
  store.deleteRepo(params.owner!, params.repo!);
  sendNoContent(ctx.res);
});

route('GET', '/repos/:owner/:repo/branches', (ctx, store, params) => {
  const repo = requireRepo(ctx, store, params.owner!, params.repo!);
  if (repo === null) return;
  const branches: Array<Record<string, unknown>> = [];
  for (const [ref, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } });
  }
  sendJson(ctx.res, 200, branches);
});

route('GET', '/repos/:owner/:repo/branches/:branch', (ctx, store, params) => {
  const repo = requireRepo(ctx, store, params.owner!, params.repo!);
  if (repo === null) return;
  const tip = repo.refs.get(`refs/heads/${params.branch}`);
  if (tip === undefined) {
    sendError(ctx.res, 404, `Branch ${params.branch} not found`);
    return;
  }
  sendJson(ctx.res, 200, { name: params.branch, commit: { sha: tip } });
});

route('GET', '/repos/:owner/:repo/commits', (ctx, store, params) => {
  const repo = requireRepo(ctx, store, params.owner!, params.repo!);
  if (repo === null) return;
  const ref = ctx.query.get('sha') ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${ref}`) ?? (isObjectId(ref) ? ref : undefined);
  if (tip === undefined) {
    sendError(ctx.res, 404, `Ref ${ref} not found`);
    return;
  }
  const params2 = pageParams(ctx.query);
  // A walk from the tip, newest first (following parents in the order they are named).
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length && out.length < 1000) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    out.push(commitView(oid, object.data));
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  const { page, link } = paginate(out, params2, `${ctx.origin}/api/v3/repos/${repo.fullName}/commits?sha=${encodeURIComponent(ref)}`);
  sendJson(ctx.res, 200, page, linkHeader(link));
});

route('GET', '/repos/:owner/:repo/contents/*', (ctx, store, params) => {
  const repo = requireRepo(ctx, store, params.owner!, params.repo!);
  if (repo === null) return;
  const ref = ctx.query.get('ref') ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${ref}`) ?? (isObjectId(ref) ? ref : undefined);
  if (tip === undefined) {
    sendError(ctx.res, 404, `Ref ${ref} not found`);
    return;
  }
  const tipObject = repo.objects.get(tip);
  if (tipObject === undefined || tipObject.type !== 'commit') {
    sendError(ctx.res, 404, 'the branch has no commit');
    return;
  }
  const treeOid = parseCommit(tipObject.data).tree;
  const path = params['*'] ?? '';
  const segments = path === '' ? [] : path.split('/');
  if (segments.length === 0) {
    // The repository root: the top-level directory listing.
    const entries = parseTree(repo.objects.get(treeOid)!.data);
    sendJson(ctx.res, 200, entries.map((entry) => directoryEntry(repo, entry, '')));
    return;
  }
  const found = findInTree(repo, treeOid, segments);
  if (found === null) {
    sendError(ctx.res, 404, `Path ${path} not found`);
    return;
  }
  const object = repo.objects.get(found.oid);
  if (object === undefined) {
    sendError(ctx.res, 404, `Path ${path} not found`);
    return;
  }
  if (found.mode === '40000') {
    const entries = parseTree(object.data);
    sendJson(ctx.res, 200, entries.map((entry) => directoryEntry(repo, entry, path)));
    return;
  }
  sendJson(ctx.res, 200, {
    type: 'file',
    name: segments[segments.length - 1],
    path,
    sha: found.oid,
    size: object.data.length,
    encoding: 'base64',
    content: b64encode(object.data.toString('utf8')),
  });
});

/** One entry of a directory listing. */
function directoryEntry(repo: Repo, entry: { mode: string; name: string; oid: string }, prefix: string): Record<string, unknown> {
  const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
  return {
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path,
    sha: entry.oid,
  };
}

/** The object a tree holds at `segments`, or null. */
function findInTree(repo: Repo, treeOid: string, segments: readonly string[]): { mode: string; oid: string } | null {
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (entry === undefined) return null;
    if (index === segments.length - 1) return { mode: entry.mode, oid: entry.oid };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

route('PUT', '/repos/:owner/:repo/contents/*', (ctx, store, params) => {
  const repo = requireRepo(ctx, store, params.owner!, params.repo!);
  if (repo === null) return;
  const body = isRecord(ctx.body) ? ctx.body : {};
  const path = params['*'] ?? '';
  if (path === '') {
    sendError(ctx.res, 422, 'the file path is empty');
    return;
  }
  const branch = asString(body.branch) === '' ? repo.defaultBranch : asString(body.branch);
  const message = asString(body.message) === '' ? `Update ${path}` : asString(body.message);
  const content = asString(body.content);
  if (content === '') {
    sendError(ctx.res, 422, 'content is required');
    return;
  }
  const bytes = b64ToBuffer(content);
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  const created = !fileExists(repo, branch, path);
  const result = store.commitFile(repo, { branch, path, content: bytes, message, sha });
  if ('error' in result) {
    const status = result.error === 'the sha does not match the current file' ? 409 : 422;
    sendError(ctx.res, status, result.error);
    return;
  }
  const status = created ? 201 : 200;
  sendJson(ctx.res, status, {
    content: { sha: result.contentSha, encoding: 'base64' },
    commit: { sha: result.commitSha },
  });
});

/** Whether a file exists at a branch's tip. */
function fileExists(repo: Repo, branch: string, path: string): boolean {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return false;
  const tipObject = repo.objects.get(tip);
  if (tipObject === undefined || tipObject.type !== 'commit') return false;
  const treeOid = parseCommit(tipObject.data).tree;
  return findInTree(repo, treeOid, path.split('/').filter((segment) => segment !== '')) !== null;
}

route('DELETE', '/repos/:owner/:repo/contents/*', (ctx, store, params) => {
  const repo = requireRepo(ctx, store, params.owner!, params.repo!);
  if (repo === null) return;
  const body = isRecord(ctx.body) ? ctx.body : {};
  const path = params['*'] ?? '';
  if (path === '') {
    sendError(ctx.res, 422, 'the file path is empty');
    return;
  }
  const branch = asString(body.branch) === '' ? repo.defaultBranch : asString(body.branch);
  const message = asString(body.message) === '' ? `Delete ${path}` : asString(body.message);
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  const result = store.deleteFile(repo, { branch, path, message, sha });
  if ('error' in result) {
    sendError(ctx.res, 404, result.error);
    return;
  }
  sendJson(ctx.res, 200, { commit: { sha: result.commitSha } });
});

route('GET', '/repos/:owner/:repo/labels', (ctx, store, params) => {
  const repo = requireRepo(ctx, store, params.owner!, params.repo!);
  if (repo === null) return;
  sendJson(ctx.res, 200, [...repo.labels.values()].map(labelView));
});

route('POST', '/repos/:owner/:repo/labels', (ctx, store, params) => {
  const repo = requireRepo(ctx, store, params.owner!, params.repo!);
  if (repo === null) return;
  const body = isRecord(ctx.body) ? ctx.body : {};
  const name = asString(body.name);
  if (name === '') {
    sendError(ctx.res, 422, 'name is required');
    return;
  }
  const existing = repo.labels.get(name);
  if (existing !== undefined) {
    sendError(ctx.res, 422, 'Label already exists');
    return;
  }
  const color = asString(body.color) === '' ? 'ededed' : asString(body.color);
  const label = store.createLabel(repo, name, color, asString(body.description));
  if (label === null) {
    sendError(ctx.res, 422, 'Label already exists');
    return;
  }
  sendJson(ctx.res, 201, labelView(label));
});

route('GET', '/repos/:owner/:repo/issues', (ctx, store, params) => {
  const repo = requireRepo(ctx, store, params.owner!, params.repo!);
  if (repo === null) return;
  const state = ctx.query.get('state') ?? 'open';
  const sort = ctx.query.get('sort') ?? 'created';
  const direction = ctx.query.get('direction') ?? 'desc';
  let issues = [...repo.issues];
  if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
  if (sort === 'created') {
    issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  }
  const params2 = pageParams(ctx.query);
  const baseUrl = `${ctx.origin}/api/v3/repos/${repo.fullName}/issues`;
  const { page, link } = paginate(issues, params2, baseUrl);
  sendJson(ctx.res, 200, page.map((issue) => issueView(repo, issue)), linkHeader(link));
});

route('POST', '/repos/:owner/:repo/issues', (ctx, store, params) => {
  const repo = requireRepo(ctx, store, params.owner!, params.repo!);
  if (repo === null) return;
  const body = isRecord(ctx.body) ? ctx.body : {};
  const title = asString(body.title);
  if (title === '') {
    sendError(ctx.res, 422, 'title is required');
    return;
  }
  const labels = Array.isArray(body.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [];
  const created = store.createIssue(repo, { title, body: asString(body.body), labels });
  if ('error' in created) {
    sendError(ctx.res, 422, created.error);
    return;
  }
  sendJson(ctx.res, 201, issueView(repo, created));
});

route('GET', '/repos/:owner/:repo/issues/:number', (ctx, store, params) => {
  const repo = requireRepo(ctx, store, params.owner!, params.repo!);
  if (repo === null) return;
  const issue = repo.issues.find((candidate) => candidate.number === Number(params.number));
  if (issue === undefined) {
    sendError(ctx.res, 404, `Issue #${params.number} not found`);
    return;
  }
  sendJson(ctx.res, 200, issueView(repo, issue));
});

route('PATCH', '/repos/:owner/:repo/issues/:number', (ctx, store, params) => {
  const repo = requireRepo(ctx, store, params.owner!, params.repo!);
  if (repo === null) return;
  const issue = repo.issues.find((candidate) => candidate.number === Number(params.number));
  if (issue === undefined) {
    sendError(ctx.res, 404, `Issue #${params.number} not found`);
    return;
  }
  const body = isRecord(ctx.body) ? ctx.body : {};
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
  if (Array.isArray(body.labels)) {
    const labels = body.labels.filter((label): label is string => typeof label === 'string');
    for (const name of labels) {
      if (!repo.labels.has(name)) {
        sendError(ctx.res, 422, `label ${name} does not exist`);
        return;
      }
    }
    issue.labels = labels;
  }
  issue.updatedAt = nowIso();
  sendJson(ctx.res, 200, issueView(repo, issue));
});

route('GET', '/repos/:owner/:repo/issues/:number/comments', (ctx, store, params) => {
  const repo = requireRepo(ctx, store, params.owner!, params.repo!);
  if (repo === null) return;
  const issue = repo.issues.find((candidate) => candidate.number === Number(params.number));
  if (issue === undefined) {
    sendError(ctx.res, 404, `Issue #${params.number} not found`);
    return;
  }
  sendJson(ctx.res, 200, issue.comments.map(commentView));
});

route('POST', '/repos/:owner/:repo/issues/:number/comments', (ctx, store, params) => {
  const repo = requireRepo(ctx, store, params.owner!, params.repo!);
  if (repo === null) return;
  const issue = repo.issues.find((candidate) => candidate.number === Number(params.number));
  if (issue === undefined) {
    sendError(ctx.res, 404, `Issue #${params.number} not found`);
    return;
  }
  const body = isRecord(ctx.body) ? ctx.body : {};
  const text = asString(body.body);
  if (text === '') {
    sendError(ctx.res, 422, 'body is required');
    return;
  }
  const comment = store.addComment(repo, issue, text);
  sendJson(ctx.res, 201, commentView(comment));
});

route('GET', '/repos/:owner/:repo/pulls', (ctx, store, params) => {
  const repo = requireRepo(ctx, store, params.owner!, params.repo!);
  if (repo === null) return;
  const state = ctx.query.get('state') ?? 'open';
  let pulls = [...repo.pulls];
  if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
  pulls.sort((a, b) => b.number - a.number);
  const params2 = pageParams(ctx.query);
  const baseUrl = `${ctx.origin}/api/v3/repos/${repo.fullName}/pulls`;
  const { page, link } = paginate(pulls, params2, baseUrl);
  sendJson(ctx.res, 200, page.map((pull) => pullView(repo, pull)), linkHeader(link));
});

route('POST', '/repos/:owner/:repo/pulls', (ctx, store, params) => {
  const repo = requireRepo(ctx, store, params.owner!, params.repo!);
  if (repo === null) return;
  const body = isRecord(ctx.body) ? ctx.body : {};
  const title = asString(body.title);
  const head = asString(body.head);
  const base = asString(body.base) === '' ? repo.defaultBranch : asString(body.base);
  if (title === '' || head === '') {
    sendError(ctx.res, 422, 'title and head are required');
    return;
  }
  const created = store.createPull(repo, { head, base, title, body: asString(body.body) });
  if ('error' in created) {
    sendError(ctx.res, 422, created.error);
    return;
  }
  sendJson(ctx.res, 201, pullView(repo, created));
});

route('GET', '/repos/:owner/:repo/pulls/:number', (ctx, store, params) => {
  const repo = requireRepo(ctx, store, params.owner!, params.repo!);
  if (repo === null) return;
  const pull = repo.pulls.find((candidate) => candidate.number === Number(params.number));
  if (pull === undefined) {
    sendError(ctx.res, 404, `Pull request #${params.number} not found`);
    return;
  }
  sendJson(ctx.res, 200, pullView(repo, pull));
});

route('GET', '/repos/:owner/:repo/pulls/:number/files', (ctx, store, params) => {
  const repo = requireRepo(ctx, store, params.owner!, params.repo!);
  if (repo === null) return;
  const pull = repo.pulls.find((candidate) => candidate.number === Number(params.number));
  if (pull === undefined) {
    sendError(ctx.res, 404, `Pull request #${params.number} not found`);
    return;
  }
  const baseTip = store.branchTip(repo, pull.base.ref);
  const headTip = store.branchTip(repo, pull.head.ref);
  if (baseTip === undefined || headTip === undefined) {
    sendError(ctx.res, 404, 'the pull request branch is missing');
    return;
  }
  const baseObject = repo.objects.get(baseTip);
  const headObject = repo.objects.get(headTip);
  if (baseObject === undefined || headObject === undefined || baseObject.type !== 'commit' || headObject.type !== 'commit') {
    sendError(ctx.res, 404, 'the pull request branch is missing');
    return;
  }
  const files = store.diffTrees(repo, parseCommit(baseObject.data).tree, parseCommit(headObject.data).tree);
  sendJson(ctx.res, 200, files);
});

route('PUT', '/repos/:owner/:repo/pulls/:number/merge', (ctx, store, params) => {
  const repo = requireRepo(ctx, store, params.owner!, params.repo!);
  if (repo === null) return;
  const pull = repo.pulls.find((candidate) => candidate.number === Number(params.number));
  if (pull === undefined) {
    sendError(ctx.res, 404, `Pull request #${params.number} not found`);
    return;
  }
  const body = isRecord(ctx.body) ? ctx.body : {};
  const methodRaw = asString(body.merge_method);
  const method = methodRaw === 'merge' || methodRaw === 'rebase' ? methodRaw : 'squash';
  const merged = store.mergePull(repo, pull, method);
  if ('error' in merged) {
    if (merged.error === 'conflict') {
      sendError(ctx.res, 405, 'the pull request has a merge conflict');
    } else {
      sendError(ctx.res, 405, 'the pull request is not open');
    }
    return;
  }
  sendJson(ctx.res, 200, { merged: true, sha: merged.sha, message: pull.title });
});

route('POST', '/repos/:owner/:repo/git/refs', (ctx, store, params) => {
  const repo = requireRepo(ctx, store, params.owner!, params.repo!);
  if (repo === null) return;
  const body = isRecord(ctx.body) ? ctx.body : {};
  const ref = asString(body.ref);
  const sha = asString(body.sha);
  if (!isValidRef(ref)) {
    sendError(ctx.res, 422, 'ref is invalid');
    return;
  }
  if (!isObjectId(sha)) {
    sendError(ctx.res, 422, 'sha is invalid');
    return;
  }
  if (repo.refs.has(ref)) {
    sendError(ctx.res, 422, 'Reference already exists');
    return;
  }
  const object = repo.objects.get(sha);
  if (object === undefined) {
    sendError(ctx.res, 422, 'the object does not exist');
    return;
  }
  repo.refs.set(ref, sha);
  sendJson(ctx.res, 201, {
    ref,
    object: { sha, type: object.type },
    url: `${ctx.origin}/api/v3/repos/${repo.fullName}/git/refs/${ref.slice('refs/'.length)}`,
  });
});

route('GET', '/repos/:owner/:repo/git/refs', (ctx, store, params) => {
  const repo = requireRepo(ctx, store, params.owner!, params.repo!);
  if (repo === null) return;
  const refs = sortedGitRefs(repo);
  sendJson(ctx.res, 200, refs);
});

route('GET', '/repos/:owner/:repo/git/refs/*', (ctx, store, params) => {
  const repo = requireRepo(ctx, store, params.owner!, params.repo!);
  if (repo === null) return;
  const ref = `refs/${params['*'] ?? ''}`;
  const oid = repo.refs.get(ref);
  if (oid === undefined) {
    sendError(ctx.res, 404, `Ref ${ref} not found`);
    return;
  }
  const object = repo.objects.get(oid);
  sendJson(ctx.res, 200, {
    ref,
    object: { sha: oid, type: object?.type ?? 'commit' },
    url: `${ctx.origin}/api/v3/repos/${repo.fullName}/git/refs/${ref.slice('refs/'.length)}`,
  });
});

/** Every ref of a repository, as the git/refs list answers them. */
function sortedGitRefs(repo: Repo): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const [ref, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const object = repo.objects.get(oid);
    out.push({ ref, object: { sha: oid, type: object?.type ?? 'commit' } });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

/**
 * Handle one REST request. Returns true when a route answered (including the 401 and the JSON
 * 404 for an unknown /api/v3 route). The caller owns the body parse: a malformed JSON body is a
 * 400, answered here before routing.
 */
export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  store: RestStore,
  token: string,
  url: URL,
): Promise<boolean> {
  const segments = splitPath(url.pathname).slice(2); // after /api/v3
  const ctx: RestContext = {
    req,
    res,
    segments,
    query: url.searchParams,
    body: undefined,
    origin: originOf(req),
    token,
  };
  if (!isAuthorized(req, token)) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }
  // A body, when present, must be valid JSON.
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    let raw: Buffer;
    try {
      raw = await readBody(req);
    } catch (err) {
      sendError(res, 400, (err as Error).message);
      return true;
    }
    if (raw.length > 0) {
      try {
        (ctx as { body: unknown }).body = parseJsonBody(raw);
      } catch {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
    }
  }
  for (const candidate of routes) {
    if (candidate.method !== method) continue;
    const params = matchRoute(candidate.pattern, segments);
    if (params === null) continue;
    await candidate.handler(ctx, store, params);
    return true;
  }
  sendError(res, 404, 'Not Found');
  return true;
}
