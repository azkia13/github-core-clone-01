// The forge's store: every repository, git object, ref, issue, pull request, label and
// comment, held in memory. One process, no disk: a trial boots the entry fresh and drives it
// to the end, so the store lives exactly as long as the process. All ids are deterministic
// counters; all global (Relay) ids are opaque base64 of a typed key, so they are stable
// across reads and never the plain numeric id.

import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './git-core.ts';
import { nowIso, nowSec } from './util.ts';

/** The login the bearer token names (wire.ts's seeded viewer). */
export const VIEWER_LOGIN = 'adaiversen';
/** The viewer's numeric id (wire.ts Scenario.viewer). */
export const VIEWER_ID = 1000;
/** The viewer's display name and email, as the scenario builds them. */
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
/** The teammate and the stranger, for completeness (no check logs in as them). */
export const TEAMMATE_LOGIN = 'quinnkeller';
export const STRANGER_LOGIN = 'olgabauer';
export const ORG_LOGIN = 'faint-meadow-org';
/** The default branch every repository is born with. */
export const DEFAULT_BRANCH = 'main';

export interface User {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

export const VIEWER: User = { id: VIEWER_ID, login: VIEWER_LOGIN, name: VIEWER_NAME, email: VIEWER_EMAIL };

/** The identity line a commit object carries for the viewer. */
export function viewerIdentity(): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
}

export interface Label {
  readonly id: number;
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface IssueComment {
  readonly id: number;
  readonly body: string;
  readonly user: User;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type IssueState = 'open' | 'closed';

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: IssueState;
  labels: string[];
  readonly user: User;
  readonly createdAt: string;
  updatedAt: string;
  readonly comments: IssueComment[];
}

export type PullState = 'open' | 'closed';

export interface PullRequest {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: PullState;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  readonly user: User;
  readonly createdAt: string;
  updatedAt: string;
}

export interface Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  readonly fullName: string;
  description: string;
  readonly private: boolean;
  readonly defaultBranch: string;
  readonly createdAt: string;
  readonly createdSeq: number;
  /** Every git object this repository holds, by id. */
  readonly objects: Map<string, GitObject>;
  /** Every ref, by full name (`refs/heads/main`), to its tip. */
  readonly refs: Map<string, string>;
  /** Labels by name. */
  readonly labels: Map<string, Label>;
  readonly issues: Issue[];
  readonly pulls: PullRequest[];
  /** The next issue/pull-request number (GitHub numbers issues and PRs together). */
  numberSeq: number;
}

/** An opaque Relay global id: base64 of `Kind:part:part`. */
export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

/** Parse an opaque global id back into its kind and parts, or null when it is not one. */
export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id.replace(/[\r\n\t ]+/g, ''), 'base64').toString('utf8');
    const segments = text.split(':');
    const kind = segments[0];
    if (kind === undefined || kind === '' || segments.length < 2) return null;
    return { kind, parts: segments.slice(1) };
  } catch {
    return null;
  }
}

/** A file change between two trees, for pull-request files. */
export interface FileChange {
  readonly filename: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

/** Split text into lines (a trailing newline does not make an empty last line). */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** A line diff by longest common subsequence (files here are small). */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const n = oldLines.length;
  const m = newLines.length;
  if (n === 0) return { additions: m, deletions: 0 };
  if (m === 0) return { additions: 0, deletions: n };
  // LCS lengths, two rows.
  let prev = new Array<number>(m + 1).fill(0);
  let curr = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    curr[0] = 0;
    for (let j = 1; j <= m; j += 1) {
      curr[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, curr[j - 1]!);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  const lcs = prev[m]!;
  return { additions: m - lcs, deletions: n - lcs };
}

/** The store. */
export class Store {
  /** Repositories by `owner/name`. */
  readonly repos = new Map<string, Repo>();
  /** The next entity id (repositories, issues, pull requests, comments, labels share one counter). */
  private nextEntityId = 1;
  /** The next repository creation sequence (list ordering). */
  private nextCreatedSeq = 1;

  private takeId(): number {
    const id = this.nextEntityId;
    this.nextEntityId += 1;
    return id;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  /** Every repository, in creation order (for the global-id lookups). */
  allRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  listReposByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => b.createdSeq - a.createdSeq);
    return out;
  }

  /** Create a repository. Null when one with that name already exists for the owner. */
  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(this.key(owner, name))) return null;
    const repo: Repo = {
      id: this.takeId(),
      name,
      owner,
      fullName: `${owner}/${name}`,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: nowIso(),
      createdSeq: this.nextCreatedSeq++,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      numberSeq: 1,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  // ---------------------------------------------------------------- git objects

  /** Store an object and answer its id. */
  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  /** Resolve a ref name, a branch name, or a commit id to a commit id. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (isObjectId(ref)) {
      const object = repo.objects.get(ref);
      if (object !== undefined && object.type === 'commit') return ref;
      return undefined;
    }
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    const direct = repo.refs.get(`refs/heads/${ref}`);
    if (direct !== undefined) return direct;
    return repo.refs.get(`refs/tags/${ref}`);
  }

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** The tip of the default branch, or undefined when the repository is empty. */
  defaultTip(repo: Repo): string | undefined {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }

  /** Whether `ancestor` is an ancestor of (or equal to) `descendant`. */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length) {
      const oid = queue.pop()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return false;
  }

  /** The merge-base of two commits: the common ancestor nearest to both, or null. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    if (a === b) return a;
    const distA = new Map<string, number>();
    const queueA: Array<[string, number]> = [[a, 0]];
    while (queueA.length) {
      const [oid, dist] = queueA.shift()!;
      if (distA.has(oid)) continue;
      distA.set(oid, dist);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueA.push([parent, dist + 1]);
    }
    const queueB: Array<[string, number]> = [[b, 0]];
    const seenB = new Set<string>();
    let best: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    while (queueB.length) {
      const [oid, dist] = queueB.shift()!;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const da = distA.get(oid);
      if (da !== undefined) {
        const score = Math.max(da, dist);
        if (score < bestScore) {
          bestScore = score;
          best = oid;
        }
      }
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueB.push([parent, dist + 1]);
    }
    return best;
  }

  // ---------------------------------------------------------------- trees

  /** The blob (or tree) a tree holds at `segments`, or null when the path is absent. */
  findPath(repo: Repo, treeOid: string, segments: readonly string[]): { mode: string; oid: string } | null {
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

  /** The entries of a tree, or null when the tree is absent. */
  treeEntries(repo: Repo, treeOid: string): TreeEntry[] | null {
    const object = repo.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return null;
    return parseTree(object.data);
  }

  /**
   * A tree with `segments` set to `blobOid` (or removed when `blobOid` is null), every other
   * entry kept. Writes the new tree objects and answers the new tree id.
   */
  setPathInTree(repo: Repo, treeOid: string | null, segments: readonly string[], blobOid: string | null): string {
    const head = segments[0];
    if (head === undefined || head === '' || head === '.' || head === '..') throw new Error('the file path has an unusable segment');
    const rest = segments.slice(1);
    const entries = treeOid === null ? [] : this.treeEntries(repo, treeOid) ?? [];
    const kept = entries.filter((entry) => entry.name !== head);
    if (rest.length === 0) {
      if (blobOid !== null) kept.push({ mode: '100644', name: head, oid: blobOid });
    } else {
      const existing = entries.find((entry) => entry.name === head && entry.mode === '40000');
      const child = this.setPathInTree(repo, existing?.oid ?? null, rest, blobOid);
      const childEntries = this.treeEntries(repo, child);
      if (childEntries !== null && childEntries.length > 0) kept.push({ mode: '40000', name: head, oid: child });
    }
    return this.putObject(repo, 'tree', buildTree(kept));
  }

  /** Every blob (and its path) a tree holds, recursively. */
  flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (tree: string, prefix: string): void => {
      const entries = this.treeEntries(repo, tree);
      if (entries === null) return;
      for (const entry of entries) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else if (entry.mode !== '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** The file changes between two trees, with line counts. */
  diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): FileChange[] {
    const base = baseTreeOid === null ? new Map() : this.flattenTree(repo, baseTreeOid);
    const head = headTreeOid === null ? new Map() : this.flattenTree(repo, headTreeOid);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const changes: FileChange[] = [];
    for (const path of [...paths].sort()) {
      const from = base.get(path);
      const to = head.get(path);
      if (from !== undefined && to === undefined) {
        const oldText = this.getObject(repo, from.oid)?.data.toString('utf8') ?? '';
        const diff = lineDiff(oldText, '');
        changes.push({ filename: path, status: 'removed', additions: 0, deletions: diff.deletions, changes: diff.deletions });
      } else if (from === undefined && to !== undefined) {
        const newText = this.getObject(repo, to.oid)?.data.toString('utf8') ?? '';
        const diff = lineDiff('', newText);
        changes.push({ filename: path, status: 'added', additions: diff.additions, deletions: 0, changes: diff.additions });
      } else if (from !== undefined && to !== undefined && from.oid !== to.oid) {
        const oldText = this.getObject(repo, from.oid)?.data.toString('utf8') ?? '';
        const newText = this.getObject(repo, to.oid)?.data.toString('utf8') ?? '';
        const diff = lineDiff(oldText, newText);
        changes.push({ filename: path, status: 'modified', additions: diff.additions, deletions: diff.deletions, changes: diff.additions + diff.deletions });
      }
    }
    return changes;
  }

  // ---------------------------------------------------------------- commits

  /** Create a commit object and store it. The message is stored exactly as given. */
  createCommit(
    repo: Repo,
    opts: { tree: string; parents: readonly string[]; message: string; author?: string; timestamp?: number },
  ): string {
    const who = opts.author ?? viewerIdentity();
    const timestamp = opts.timestamp ?? nowSec();
    return this.putObject(
      repo,
      'commit',
      buildCommit({ tree: opts.tree, parents: opts.parents, message: opts.message, author: who, committer: who, timestamp }),
    );
  }

  /** The commit ids reachable from a ref, tip first (following first parents only for the list order). */
  commitList(repo: Repo, tip: string, limit = 100): Array<{ sha: string; commit: ReturnType<typeof parseCommit>; object: GitObject }> {
    const out: Array<{ sha: string; commit: ReturnType<typeof parseCommit>; object: GitObject }> = [];
    const seen = new Set<string>();
    // A simple walk: newest first by following parents, in the order they are named.
    const queue: string[] = [tip];
    while (queue.length && out.length < limit) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      out.push({ sha: oid, commit: parseCommit(object.data), object });
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return out;
  }

  // ---------------------------------------------------------------- contents

  /**
   * Write a file through the contents API: a new blob, a new tree, a new commit on `branch`.
   * `sha` is the blob id the caller believes the file has now; a mismatch is a 409.
   * Returns the commit and content (blob) ids.
   */
  commitFile(
    repo: Repo,
    opts: { branch: string; path: string; content: Buffer; message: string; sha?: string },
  ): { commitSha: string; contentSha: string } | { error: string } {
    const segments = opts.path.split('/').filter((segment) => segment !== '');
    if (segments.length === 0) return { error: 'the file path is empty' };
    const tip = this.branchTip(repo, opts.branch);
    const baseTree = tip === undefined ? null : parseCommit(repo.objects.get(tip)!.data).tree;
    const current = baseTree === null ? null : this.findPath(repo, baseTree, segments);
    if (opts.sha !== undefined) {
      if (current === null) return { error: 'the file does not exist' };
      if (current.oid.toLowerCase() !== opts.sha.toLowerCase()) return { error: 'the sha does not match the current file' };
    }
    const blobOid = this.putObject(repo, 'blob', opts.content);
    const treeOid = this.setPathInTree(repo, baseTree, segments, blobOid);
    const commitSha = this.createCommit(repo, {
      tree: treeOid,
      parents: tip === undefined ? [] : [tip],
      message: opts.message,
    });
    repo.refs.set(`refs/heads/${opts.branch}`, commitSha);
    return { commitSha, contentSha: blobOid };
  }

  /** Delete a file through the contents API. */
  deleteFile(
    repo: Repo,
    opts: { branch: string; path: string; message: string; sha?: string },
  ): { commitSha: string } | { error: string } {
    const segments = opts.path.split('/').filter((segment) => segment !== '');
    if (segments.length === 0) return { error: 'the file path is empty' };
    const tip = this.branchTip(repo, opts.branch);
    if (tip === undefined) return { error: 'the branch does not exist' };
    const baseTree = parseCommit(repo.objects.get(tip)!.data).tree;
    const current = this.findPath(repo, baseTree, segments);
    if (current === null) return { error: 'the file does not exist' };
    if (opts.sha !== undefined && current.oid.toLowerCase() !== opts.sha.toLowerCase()) {
      return { error: 'the sha does not match the current file' };
    }
    const treeOid = this.setPathInTree(repo, baseTree, segments, null);
    const commitSha = this.createCommit(repo, { tree: treeOid, parents: [tip], message: opts.message });
    repo.refs.set(`refs/heads/${opts.branch}`, commitSha);
    return { commitSha };
  }

  // ---------------------------------------------------------------- issues

  /** Create a label. Null when one with that name already exists. */
  createLabel(repo: Repo, name: string, color: string, description = ''): Label | null {
    if (repo.labels.has(name)) return null;
    const label: Label = { id: this.takeId(), name, color, description };
    repo.labels.set(name, label);
    return label;
  }

  /** Create an issue. `error` names an unknown label. */
  createIssue(
    repo: Repo,
    opts: { title: string; body: string; labels?: readonly string[] },
  ): Issue | { error: string } {
    const labels = opts.labels ?? [];
    for (const name of labels) if (!repo.labels.has(name)) return { error: `label ${name} does not exist` };
    // One clock reading: created and updated are the same instant at creation.
    const now = nowIso();
    const issue: Issue = {
      id: this.takeId(),
      number: repo.numberSeq++,
      title: opts.title,
      body: opts.body,
      state: 'open',
      labels: [...labels],
      user: VIEWER,
      createdAt: now,
      updatedAt: now,
      comments: [],
    };
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  addComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const now = nowIso();
    const comment: IssueComment = { id: this.takeId(), body, user: VIEWER, createdAt: now, updatedAt: now };
    issue.comments.push(comment);
    return comment;
  }

  // ---------------------------------------------------------------- pull requests

  /** Create a pull request. `error` names a missing branch. */
  createPull(
    repo: Repo,
    opts: { head: string; base: string; title: string; body: string },
  ): PullRequest | { error: string } {
    const headSha = this.branchTip(repo, opts.head);
    if (headSha === undefined) return { error: `the head branch ${opts.head} does not exist` };
    const baseSha = this.branchTip(repo, opts.base);
    if (baseSha === undefined) return { error: `the base branch ${opts.base} does not exist` };
    const now = nowIso();
    const pull: PullRequest = {
      id: this.takeId(),
      number: repo.numberSeq++,
      title: opts.title,
      body: opts.body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head: { ref: opts.head, sha: headSha },
      base: { ref: opts.base, sha: baseSha },
      user: VIEWER,
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): PullRequest | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  /** Whether a pull request would conflict, by a file-level three-way check against its merge-base. */
  pullConflicts(repo: Repo, pull: PullRequest): boolean {
    const headTip = this.branchTip(repo, pull.head.ref);
    const baseTip = this.branchTip(repo, pull.base.ref);
    if (headTip === undefined || baseTip === undefined) return true;
    const base = this.mergeBase(repo, baseTip, headTip);
    if (base === null) return true;
    const baseTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
    const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
    const ancestorTree = parseCommit(repo.objects.get(base)!.data).tree;
    const baseFiles = this.flattenTree(repo, baseTree);
    const headFiles = this.flattenTree(repo, headTree);
    const ancestorFiles = this.flattenTree(repo, ancestorTree);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...ancestorFiles.keys()]);
    for (const path of paths) {
      const ancestor = ancestorFiles.get(path)?.oid ?? null;
      const atBase = baseFiles.get(path)?.oid ?? null;
      const atHead = headFiles.get(path)?.oid ?? null;
      if (ancestor === null) {
        // Added on both sides with different content.
        if (atBase !== null && atHead !== null && atBase !== atHead) return true;
        continue;
      }
      const baseChanged = atBase !== ancestor;
      const headChanged = atHead !== ancestor;
      if (baseChanged && headChanged && atBase !== atHead) return true;
    }
    return false;
  }

  /**
   * Merge a pull request. `method` is `squash` (one commit on the base branch, tree = the head
   * tree) or `merge` (a merge commit with two parents). Returns the merge commit id, or an
   * error: `conflict` (405) or `already` (the pull is not open).
   */
  mergePull(repo: Repo, pull: PullRequest, method: 'squash' | 'merge' | 'rebase'): { sha: string } | { error: 'conflict' | 'already' } {
    if (pull.state !== 'open') return { error: 'already' };
    if (this.pullConflicts(repo, pull)) return { error: 'conflict' };
    const headTip = this.branchTip(repo, pull.head.ref)!;
    const baseTip = this.branchTip(repo, pull.base.ref)!;
    const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
    const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
    const message = method === 'squash' ? pull.title : `Merge pull request #${pull.number} from ${pull.head.ref}`;
    const sha = this.createCommit(repo, { tree: headTree, parents, message });
    repo.refs.set(`refs/heads/${pull.base.ref}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = nowIso();
    pull.mergeCommitSha = sha;
    pull.updatedAt = pull.mergedAt;
    pull.head.sha = headTip;
    pull.base.sha = sha;
    return { sha };
  }

  /** The pull request's mergeability, as GraphQL reports it. */
  pullMergeable(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    return this.pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
  }

  // ---------------------------------------------------------------- git helpers

  /** Every object reachable from a ref's tip (for the upload-pack have-closure). */
  reachableFrom(repo: Repo, oid: string, stopAt: ReadonlySet<string> = new Set()): Set<string> {
    const seen = new Set<string>();
    const queue = [oid];
    while (queue.length) {
      const current = queue.pop()!;
      if (seen.has(current)) continue;
      const object = repo.objects.get(current);
      if (!object) continue;
      seen.add(current);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        if (!stopAt.has(current)) for (const parent of commit.parents) queue.push(parent);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode === '160000') continue;
          queue.push(entry.oid);
        }
      }
    }
    return seen;
  }
}

/** The one store the server serves. */
export const store = new Store();

/** The peeled commit of a tag (following annotated tags), or the oid itself. */
export function peelToCommit(repo: Repo, oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 10; depth += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

/** Whether a ref is a tag ref. */
export function isTagRef(ref: string): boolean {
  return ref.startsWith('refs/tags/');
}

/** The short name of a ref (`refs/heads/main` -> `main`). */
export function refShortName(ref: string): string {
  return ref.replace(/^refs\/(heads|tags)\//, '');
}

export { ZERO_OID, collectReachable };
