// The GraphQL v4 surface (`/api/graphql`): a small executor for exactly the documents gh and
// github-mcp-server send — viewer and repository reads, the `__type` feature probes, issue and
// pull-request reads and the create/close/merge/comment mutations, plus Relay `node(id:)` and
// operation batching. A hand-rolled recursive-descent parser (no dependency): the documents are
// fixed shapes, so the parser covers operations, variables, arguments (scalars, enums, lists,
// input objects), aliases and inline fragments, and reports an unknown field as a GraphQL
// error (HTTP 200 with an `errors` array naming the field), never an HTTP 400.

import { parseCommit } from './git-core.ts';
import {
  DEFAULT_BRANCH,
  VIEWER,
  globalId,
  parseGlobalId,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// schema: the types and fields this executor knows, for validation and introspection.
// ---------------------------------------------------------------------------------------------

const SCHEMA_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  IssueConnection: ['nodes', 'pageInfo'],
  PageInfo: ['hasNextPage', 'endCursor'],
  PullRequest: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  PullRequestConnection: ['nodes'],
  PullRequestChangedFile: ['path'],
  Ref: ['name'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  IssueCommentEdge: ['node'],
  IssueComment: ['id', 'body'],
  __Type: ['name', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'WIKI', 'PACKAGE', 'MARKETPLACE'];

/** The GraphQL type of a node this executor hands out. */
type NodeKind = 'Query' | 'Mutation' | 'User' | 'Repository' | 'Issue' | 'IssueConnection' | 'PageInfo' | 'PullRequest' | 'PullRequestConnection' | 'PullRequestChangedFile' | 'Ref' | 'CreateIssuePayload' | 'CloseIssuePayload' | 'CreatePullRequestPayload' | 'MergePullRequestPayload' | 'AddCommentPayload' | 'IssueCommentEdge' | 'IssueComment' | '__Type' | '__Field' | '__EnumValue';

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  readonly kind: 'field';
  readonly name: string;
  readonly alias: string | null;
  readonly args: Array<{ name: string; value: ValueNode }>;
  readonly selectionSet: SelectionNode[] | null;
}

interface InlineFragmentNode {
  readonly kind: 'inlineFragment';
  readonly typeCondition: string | null;
  readonly selectionSet: SelectionNode[];
}

type SelectionNode = FieldNode | InlineFragmentNode;

interface OperationNode {
  readonly kind: 'query' | 'mutation';
  readonly name: string | null;
  readonly variables: Array<{ name: string; defaultValue: ValueNode | null }>;
  readonly selectionSet: SelectionNode[];
}

interface Token {
  readonly kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread' | 'variable' | 'eof';
  readonly value: string;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (index < text.length) {
    const ch = text[index]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '#') {
      if (ch === '#') {
        while (index < text.length && text[index] !== '\n') index += 1;
      } else {
        index += 1;
      }
      continue;
    }
    if (ch === '.' && text[index + 1] === '.' && text[index + 2] === '.') {
      tokens.push({ kind: 'spread', value: '...' });
      index += 3;
      continue;
    }
    if (ch === '$') {
      let end = index + 1;
      while (end < text.length && isNameChar(text[end]!)) end += 1;
      tokens.push({ kind: 'variable', value: text.slice(index + 1, end) });
      index = end;
      continue;
    }
    if (ch === '"') {
      let end = index + 1;
      let value = '';
      while (end < text.length && text[end] !== '"') {
        if (text[end] === '\\' && end + 1 < text.length) {
          const escaped = text[end + 1]!;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          end += 2;
        } else {
          value += text[end];
          end += 1;
        }
      }
      if (end >= text.length) throw new Error('unterminated string in the GraphQL document');
      tokens.push({ kind: 'string', value });
      index = end + 1;
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      let end = index;
      if (text[end] === '-') end += 1;
      while (end < text.length && /[0-9]/.test(text[end]!)) end += 1;
      let isFloat = false;
      if (text[end] === '.') {
        isFloat = true;
        end += 1;
        while (end < text.length && /[0-9]/.test(text[end]!)) end += 1;
      }
      if (text[end] === 'e' || text[end] === 'E') {
        isFloat = true;
        end += 1;
        if (text[end] === '+' || text[end] === '-') end += 1;
        while (end < text.length && /[0-9]/.test(text[end]!)) end += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: text.slice(index, end) });
      index = end;
      continue;
    }
    if (isNameStart(ch)) {
      let end = index;
      while (end < text.length && isNameChar(text[end]!)) end += 1;
      tokens.push({ kind: 'name', value: text.slice(index, end) });
      index = end;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      index += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in the GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private index = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.index]!;
  }

  private next(): Token {
    const token = this.tokens[this.index]!;
    this.index += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${JSON.stringify(value)} in the GraphQL document, got ${JSON.stringify(token.value)}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name in the GraphQL document, got ${JSON.stringify(token.value)}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${JSON.stringify(value)} in the GraphQL document, got ${JSON.stringify(token.value)}`);
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): OperationNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '{') {
      return { kind: 'query', name: null, variables: [], selectionSet: this.parseSelectionSet() };
    }
    const kind = this.expectName();
    if (kind !== 'query' && kind !== 'mutation') throw new Error(`unsupported operation ${JSON.stringify(kind)}`);
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.next().value;
    const variables: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const variable = this.next();
        if (variable.kind !== 'variable') throw new Error('expected a variable in the variable definitions');
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variables.push({ name: variable.value, defaultValue });
      }
      this.next();
    }
    return { kind, name, variables, selectionSet: this.parseSelectionSet() };
  }

  /** Skip a type annotation (`String!`, `[IssueState!]`, `CreateIssueInput!`). */
  private parseType(): void {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.next();
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'spread') {
      this.next();
      let typeCondition: string | null = null;
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.next();
    }
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selectionSet };
  }

  parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'variable') return { kind: 'variable', name: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.next();
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value ${JSON.stringify(token.value)} in the GraphQL document`);
  }
}

// ---------------------------------------------------------------------------------------------
// values: the nodes the executor hands out, each with its GraphQL type.
// ---------------------------------------------------------------------------------------------

interface GqlNode {
  readonly __typename: NodeKind;
  readonly [key: string]: unknown;
}

function issueState(issue: Issue): 'OPEN' | 'CLOSED' {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRequest): 'OPEN' | 'CLOSED' | 'MERGED' {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

/** The cursor of an issue page: base64 of `cursor:<number>`. */
function issueCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeIssueCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor.replace(/[\r\n\t ]+/g, ''), 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

export interface GraphQLStore {
  getRepo(owner: string, name: string): Repo | undefined;
  createIssue(repo: Repo, opts: { title: string; body: string; labels?: readonly string[] }): Issue | { error: string };
  addComment(repo: Repo, issue: Issue, body: string): Issue['comments'][number];
  createPull(repo: Repo, opts: { head: string; base: string; title: string; body: string }): PullRequest | { error: string };
  mergePull(repo: Repo, pull: PullRequest, method: 'squash' | 'merge' | 'rebase'): { sha: string } | { error: 'conflict' | 'already' };
  pullMergeable(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): Array<{ filename: string }>;
  branchTip(repo: Repo, branch: string): string | undefined;
}

export interface GraphQLResult {
  readonly data: Record<string, unknown> | null;
  readonly errors: Array<{ message: string }>;
}

interface Executor {
  readonly store: GraphQLStoreFull;
  readonly errors: Array<{ message: string }>;
}

/** Resolve a value node to its JSON value, substituting variables. */
function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argMap(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Execute a selection set against a node, answering its fields. */
function executeSelectionSet(
  executor: Executor,
  node: GqlNode | null,
  selections: readonly SelectionNode[],
  variables: Record<string, unknown>,
): Record<string, unknown> | null {
  if (node === null) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== node.__typename) continue;
      const fragment = executeSelectionSet(executor, node, selection.selectionSet, variables);
      if (fragment !== null) Object.assign(out, fragment);
      continue;
    }
    const key = selection.alias ?? selection.name;
    const fields = SCHEMA_FIELDS[node.__typename] ?? [];
    if (!fields.includes(selection.name)) {
      executor.errors.push({ message: `Cannot query field "${selection.name}" on type "${node.__typename}".` });
      out[key] = null;
      continue;
    }
    const value = resolveField(executor, node, selection, variables);
    if (selection.selectionSet === null) {
      out[key] = value;
    } else if (value === null || value === undefined) {
      out[key] = null;
    } else if (Array.isArray(value)) {
      out[key] = value.map((entry) =>
        isRecord(entry) && typeof entry.__typename === 'string'
          ? executeSelectionSet(executor, entry as GqlNode, selection.selectionSet!, variables)
          : entry,
      );
    } else if (isRecord(value) && typeof value.__typename === 'string') {
      out[key] = executeSelectionSet(executor, value as GqlNode, selection.selectionSet, variables);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** The value of one field of a node. */
function resolveField(executor: Executor, node: GqlNode, field: FieldNode, variables: Record<string, unknown>): unknown {
  const args = argMap(field, variables);
  const store = executor.store;
  switch (node.__typename) {
    case 'Query': {
      if (field.name === 'viewer') return { __typename: 'User' as const, login: VIEWER.login } satisfies GqlNode;
      if (field.name === 'repository') {
        const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === undefined ? null : repoNode(repo);
      }
      if (field.name === 'node') {
        return nodeById(executor, String(args.id ?? ''));
      }
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        if (!(name in SCHEMA_FIELDS) && name !== 'SearchType') return null;
        return { __typename: '__Type' as const, name } satisfies GqlNode;
      }
      return null;
    }
    case 'Mutation': {
      if (field.name === 'createIssue') return createIssuePayload(executor, args);
      if (field.name === 'closeIssue') return closeIssuePayload(executor, args);
      if (field.name === 'createPullRequest') return createPullRequestPayload(executor, args);
      if (field.name === 'mergePullRequest') return mergePullRequestPayload(executor, args);
      if (field.name === 'addComment') return addCommentPayload(executor, args);
      return null;
    }
    case 'User': {
      if (field.name === 'login') return node.login as string;
      if (field.name === 'id') return globalId('User', 1000);
      return null;
    }
    case 'Repository': {
      const repo = node.repo as Repo;
      if (field.name === 'id') return globalId('Repository', repo.id);
      if (field.name === 'databaseId') return repo.id;
      if (field.name === 'name') return repo.name;
      if (field.name === 'nameWithOwner') return repo.fullName;
      if (field.name === 'owner') return { __typename: 'User' as const, login: repo.owner } satisfies GqlNode;
      if (field.name === 'defaultBranchRef') {
        const tip = store.branchTip(repo, repo.defaultBranch);
        return tip === undefined ? null : { __typename: 'Ref' as const, name: repo.defaultBranch } satisfies GqlNode;
      }
      if (field.name === 'viewerPermission') return 'ADMIN';
      if (field.name === 'hasIssuesEnabled') return true;
      if (field.name === 'issue') {
        const issue = repo.issues.find((candidate) => candidate.number === Number(args.number));
        return issue === undefined ? null : issueNode(repo, issue);
      }
      if (field.name === 'issues') return issuesConnection(repo, args);
      if (field.name === 'pullRequests') return pullRequestsConnection(repo, args);
      if (field.name === 'pullRequest') {
        const pull = repo.pulls.find((candidate) => candidate.number === Number(args.number));
        return pull === undefined ? null : pullNode(repo, pull);
      }
      return null;
    }
    case 'Issue': {
      const issue = node.issue as Issue;
      const repo = node.repo as Repo;
      if (field.name === 'id') return globalId('Issue', repo.id, issue.number);
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'state') return issueState(issue);
      if (field.name === 'body') return issue.body;
      return null;
    }
    case 'IssueConnection': {
      if (field.name === 'nodes') return node.nodes as GqlNode[];
      if (field.name === 'pageInfo') return node.pageInfo as GqlNode;
      return null;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return node.hasNextPage as boolean;
      if (field.name === 'endCursor') return node.endCursor as string | null;
      return null;
    }
    case 'PullRequest': {
      const pull = node.pull as PullRequest;
      const repo = node.repo as Repo;
      if (field.name === 'id') return globalId('PullRequest', repo.id, pull.number);
      if (field.name === 'number') return pull.number;
      if (field.name === 'state') return pullState(pull);
      if (field.name === 'merged') return pull.merged;
      if (field.name === 'headRefName') return pull.head.ref;
      if (field.name === 'baseRefName') return pull.base.ref;
      if (field.name === 'mergeable') return store.pullMergeable(repo, pull);
      if (field.name === 'files') return pullFilesConnection(executor, repo, pull, args);
      return null;
    }
    case 'PullRequestConnection': {
      if (field.name === 'nodes') return node.nodes as GqlNode[];
      return null;
    }
    case 'PullRequestChangedFile': {
      if (field.name === 'path') return node.path as string;
      return null;
    }
    case 'Ref': {
      if (field.name === 'name') return node.name as string;
      return null;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return node.issue as GqlNode | null;
      return null;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return node.pullRequest as GqlNode | null;
      return null;
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return node.commentEdge as GqlNode | null;
      return null;
    }
    case 'IssueCommentEdge': {
      if (field.name === 'node') return node.node as GqlNode | null;
      return null;
    }
    case 'IssueComment': {
      if (field.name === 'id') return node.id as string;
      if (field.name === 'body') return node.body as string;
      return null;
    }
    case '__Type': {
      const name = node.name as string;
      if (field.name === 'name') return name;
      if (field.name === 'fields') {
        const names = SCHEMA_FIELDS[name] ?? [];
        return names.map((fieldName) => ({ __typename: '__Field' as const, name: fieldName }) satisfies GqlNode);
      }
      if (field.name === 'enumValues') {
        if (name !== 'SearchType') return null;
        return SEARCH_TYPE_VALUES.map((value) => ({ __typename: '__EnumValue' as const, name: value }) satisfies GqlNode);
      }
      return null;
    }
    case '__Field':
    case '__EnumValue': {
      if (field.name === 'name') return node.name as string;
      return null;
    }
    default:
      return null;
  }
}

function repoNode(repo: Repo): GqlNode {
  return { __typename: 'Repository', repo };
}

function issueNode(repo: Repo, issue: Issue): GqlNode {
  return { __typename: 'Issue', repo, issue };
}

function pullNode(repo: Repo, pull: PullRequest): GqlNode {
  return { __typename: 'PullRequest', repo, pull };
}

/** The issues connection: filter by state, order, page by cursor. */
function issuesConnection(repo: Repo, args: Record<string, unknown>): GqlNode {
  let issues = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
  const direction = String(orderBy.direction ?? 'ASC').toUpperCase();
  const field = String(orderBy.field ?? 'CREATED_AT').toUpperCase();
  if (field === 'CREATED_AT' || field === 'UPDATED_AT') {
    issues.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  }
  const first = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : issues.length;
  const after = typeof args.after === 'string' ? decodeIssueCursor(args.after) : null;
  if (after !== null) {
    issues = direction === 'DESC' ? issues.filter((issue) => issue.number < after) : issues.filter((issue) => issue.number > after);
  }
  const page = issues.slice(0, first);
  const hasNextPage = issues.length > page.length;
  const endCursor = page.length > 0 ? issueCursor(page[page.length - 1]!.number) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueNode(repo, issue)),
    pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
  };
}

/** The pull-requests connection (newest first). */
function pullRequestsConnection(repo: Repo, args: Record<string, unknown>): GqlNode {
  const pulls = [...repo.pulls].sort((a, b) => b.number - a.number);
  const first = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : pulls.length;
  return {
    __typename: 'PullRequestConnection',
    nodes: pulls.slice(0, first).map((pull) => pullNode(repo, pull)),
  };
}

/** A pull request's changed files, as a connection. */
function pullFilesConnection(executor: Executor, repo: Repo, pull: PullRequest, args: Record<string, unknown>): GqlNode {
  const baseTip = executor.store.branchTip(repo, pull.base.ref);
  const headTip = executor.store.branchTip(repo, pull.head.ref);
  let files: Array<{ filename: string }> = [];
  if (baseTip !== undefined && headTip !== undefined) {
    const baseObject = repo.objects.get(baseTip);
    const headObject = repo.objects.get(headTip);
    if (baseObject !== undefined && headObject !== undefined && baseObject.type === 'commit' && headObject.type === 'commit') {
      files = executor.store.diffTrees(repo, parseCommit(baseObject.data).tree, parseCommit(headObject.data).tree);
    }
  }
  const first = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : files.length;
  return {
    __typename: 'PullRequestConnection',
    nodes: files.slice(0, first).map((file) => ({ __typename: 'PullRequestChangedFile' as const, path: file.filename }) satisfies GqlNode),
  };
}

/** `node(id:)`: the object a global id names, or null. */
function nodeById(executor: Executor, id: string): GqlNode | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.kind === 'Repository') {
    const repoId = Number(parsed.parts[0]);
    for (const repo of executor.store.allRepos()) {
      if (repo.id === repoId) return repoNode(repo);
    }
    return null;
  }
  if (parsed.kind === 'Issue') {
    const repoId = Number(parsed.parts[0]);
    const number = Number(parsed.parts[1]);
    for (const repo of executor.store.allRepos()) {
      if (repo.id !== repoId) continue;
      const issue = repo.issues.find((candidate) => candidate.number === number);
      return issue === undefined ? null : issueNode(repo, issue);
    }
    return null;
  }
  if (parsed.kind === 'PullRequest') {
    const repoId = Number(parsed.parts[0]);
    const number = Number(parsed.parts[1]);
    for (const repo of executor.store.allRepos()) {
      if (repo.id !== repoId) continue;
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      return pull === undefined ? null : pullNode(repo, pull);
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------------------------

function createIssuePayload(executor: Executor, args: Record<string, unknown>): GqlNode {
  const input = isRecord(args.input) ? args.input : {};
  const parsed = parseGlobalId(String(input.repositoryId ?? ''));
  if (parsed === null || parsed.kind !== 'Repository') return { __typename: 'CreateIssuePayload', issue: null };
  const repoId = Number(parsed.parts[0]);
  const repo = executor.store.allRepos().find((candidate) => candidate.id === repoId);
  if (repo === undefined) return { __typename: 'CreateIssuePayload', issue: null };
  const created = executor.store.createIssue(repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
  if ('error' in created) return { __typename: 'CreateIssuePayload', issue: null };
  return { __typename: 'CreateIssuePayload', issue: issueNode(repo, created) };
}

function closeIssuePayload(executor: Executor, args: Record<string, unknown>): GqlNode {
  const input = isRecord(args.input) ? args.input : {};
  const parsed = parseGlobalId(String(input.issueId ?? ''));
  if (parsed === null || parsed.kind !== 'Issue') return { __typename: 'CloseIssuePayload', issue: null };
  const repoId = Number(parsed.parts[0]);
  const number = Number(parsed.parts[1]);
  for (const repo of executor.store.allRepos()) {
    if (repo.id !== repoId) continue;
    const issue = repo.issues.find((candidate) => candidate.number === number);
    if (issue === undefined) return { __typename: 'CloseIssuePayload', issue: null };
    issue.state = 'closed';
    issue.updatedAt = new Date().toISOString();
    return { __typename: 'CloseIssuePayload', issue: issueNode(repo, issue) };
  }
  return { __typename: 'CloseIssuePayload', issue: null };
}

function createPullRequestPayload(executor: Executor, args: Record<string, unknown>): GqlNode {
  const input = isRecord(args.input) ? args.input : {};
  const parsed = parseGlobalId(String(input.repositoryId ?? ''));
  if (parsed === null || parsed.kind !== 'Repository') return { __typename: 'CreatePullRequestPayload', pullRequest: null };
  const repoId = Number(parsed.parts[0]);
  const repo = executor.store.allRepos().find((candidate) => candidate.id === repoId);
  if (repo === undefined) return { __typename: 'CreatePullRequestPayload', pullRequest: null };
  const created = executor.store.createPull(repo, {
    head: String(input.headRefName ?? ''),
    base: String(input.baseRefName ?? ''),
    title: String(input.title ?? ''),
    body: '',
  });
  if ('error' in created) return { __typename: 'CreatePullRequestPayload', pullRequest: null };
  return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, created) };
}

function mergePullRequestPayload(executor: Executor, args: Record<string, unknown>): GqlNode {
  const input = isRecord(args.input) ? args.input : {};
  const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
  if (parsed === null || parsed.kind !== 'PullRequest') return { __typename: 'MergePullRequestPayload', pullRequest: null };
  const repoId = Number(parsed.parts[0]);
  const number = Number(parsed.parts[1]);
  const methodRaw = String(input.mergeMethod ?? 'SQUASH').toUpperCase();
  const method = methodRaw === 'MERGE' ? 'merge' : methodRaw === 'REBASE' ? 'rebase' : 'squash';
  for (const repo of executor.store.allRepos()) {
    if (repo.id !== repoId) continue;
    const pull = repo.pulls.find((candidate) => candidate.number === number);
    if (pull === undefined) return { __typename: 'MergePullRequestPayload', pullRequest: null };
    const merged = executor.store.mergePull(repo, pull, method);
    if ('error' in merged) return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(repo, pull) };
    return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(repo, pull) };
  }
  return { __typename: 'MergePullRequestPayload', pullRequest: null };
}

function addCommentPayload(executor: Executor, args: Record<string, unknown>): GqlNode {
  const input = isRecord(args.input) ? args.input : {};
  const parsed = parseGlobalId(String(input.subjectId ?? ''));
  if (parsed === null || parsed.kind !== 'Issue') return { __typename: 'AddCommentPayload', commentEdge: null };
  const repoId = Number(parsed.parts[0]);
  const number = Number(parsed.parts[1]);
  for (const repo of executor.store.allRepos()) {
    if (repo.id !== repoId) continue;
    const issue = repo.issues.find((candidate) => candidate.number === number);
    if (issue === undefined) return { __typename: 'AddCommentPayload', commentEdge: null };
    const comment = executor.store.addComment(repo, issue, String(input.body ?? ''));
    return {
      __typename: 'AddCommentPayload',
      commentEdge: {
        __typename: 'IssueCommentEdge',
        node: { __typename: 'IssueComment', id: globalId('IssueComment', repo.id, comment.id), body: comment.body },
      },
    };
  }
  return { __typename: 'AddCommentPayload', commentEdge: null };
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

/** The store surface the GraphQL executor needs (the one Store, plus its repo list). */
export interface GraphQLStoreFull extends GraphQLStore {
  allRepos(): Repo[];
}

/**
 * Execute one GraphQL operation document against the store. `variables` are the JSON variables
 * the client sent; `operationName` selects among several operations. Answers `{data, errors}`:
 * an unknown field is a GraphQL error (the data carries null for it), never an HTTP error.
 */
export function executeGraphQL(
  store: GraphQLStoreFull,
  document: string,
  variables: Record<string, unknown>,
  operationName?: string,
): GraphQLResult {
  const executor: Executor = { store, errors: [] };
  let operations: OperationNode[];
  try {
    operations = new Parser(tokenize(document)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: (err as Error).message }] };
  }
  if (operations.length === 0) {
    return { data: null, errors: [{ message: 'the document holds no operation' }] };
  }
  let operation = operations[0]!;
  if (operationName !== undefined) {
    const named = operations.find((candidate) => candidate.name === operationName);
    if (named === undefined) {
      return { data: null, errors: [{ message: `no operation named ${JSON.stringify(operationName)}` }] };
    }
    operation = named;
  }
  const resolvedVariables: Record<string, unknown> = { ...variables };
  for (const definition of operation.variables) {
    if (!(definition.name in resolvedVariables) && definition.defaultValue !== null) {
      resolvedVariables[definition.name] = resolveValue(definition.defaultValue, variables);
    }
  }
  const root: GqlNode = operation.kind === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  const data = executeSelectionSet(executor, root, operation.selectionSet, resolvedVariables);
  return { data, errors: executor.errors };
}

export { DEFAULT_BRANCH, VIEWER };
