// graphql.ts — a small GraphQL executor for the exact documents gh and
// github-mcp-server send: viewer/repository reads, __type introspection,
// issue and pull-request reads and mutations, node(id:), and batched bodies.
//
// It is a hand-rolled parser (the documents are fixed and small) over the
// same store REST uses, so every mutation is visible on the REST surface.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER,
  branchTip,
  createIssue,
  createPull,
  globalId,
  mergeConflicts,
  mergeBase,
  parseGlobalId,
  squashMerge,
  treeAt,
  diffTrees,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { hasBearer, parseJsonBody, readBody, sendJson } from './util.ts';

// ---------------------------------------------------------------- tokenizer

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.]/.test(input[j]!)) j += 1;
      const text = input.slice(i, j);
      tokens.push(text.includes('.') ? { kind: 'float', value: text } : { kind: 'int', value: text });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_A-Za-z0-9]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------- AST

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

interface FieldSelection {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, Value>;
  selections: Selection[];
}

interface FragmentSpread {
  kind: 'spread';
  name: string;
}

interface InlineFragment {
  kind: 'inline';
  typeCondition: string | null;
  selections: Selection[];
}

type Selection = FieldSelection | FragmentSpread | InlineFragment;

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variableDefs: Record<string, { default?: Value }>;
  selections: Selection[];
}

interface FragmentDef {
  name: string;
  typeCondition: string;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Record<string, FragmentDef>;
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.kind} ${token.value}`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.kind}`);
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments: Record<string, FragmentDef> = {};
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, variableDefs: {}, selections: this.parseSelections() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const type = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek()?.kind === 'name') name = this.expectName();
        const variableDefs = this.parseVariableDefs();
        operations.push({ type, name, variableDefs, selections: this.parseSelections() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in fragment definition');
        const typeCondition = this.expectName();
        fragments[name] = { name, typeCondition, selections: this.parseSelections() };
        continue;
      }
      throw new Error(`unexpected token ${token.kind} ${token.value} at document top level`);
    }
    return { operations, fragments };
  }

  private parseVariableDefs(): Record<string, { default?: Value }> {
    const defs: Record<string, { default?: Value }> = {};
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        this.expectPunct('$');
        const name = this.expectName();
        this.expectPunct(':');
        this.parseType();
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
          this.next();
          defs[name] = { default: this.parseValue() };
        } else {
          defs[name] = {};
        }
      }
      this.expectPunct(')');
    }
    return defs;
  }

  private parseType(): void {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '!') this.next();
  }

  private parseSelections(): Selection[] {
    this.expectPunct('{');
    const out: Selection[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      out.push(this.parseSelection());
    }
    this.expectPunct('}');
    return out;
  }

  private parseSelection(): Selection {
    const token = this.peek()!;
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek()!;
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inline', typeCondition, selections: this.parseSelections() };
      }
      if (next.kind === 'name') {
        return { kind: 'spread', name: this.expectName() };
      }
      return { kind: 'inline', typeCondition: null, selections: this.parseSelections() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    // Directives (@include/@skip): skip them, they are not used by the suite.
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t.kind === 'punct' && t.value === '(') depth += 1;
          if (t.kind === 'punct' && t.value === ')') depth -= 1;
        }
      }
    }
    const args = this.parseArgs();
    let selections: Selection[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') selections = this.parseSelections();
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArgs(): Record<string, Value> {
    const args: Record<string, Value> = {};
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const name = this.expectName();
        this.expectPunct(':');
        args[name] = this.parseValue();
      }
      this.expectPunct(')');
    }
    return args;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, Value> = {};
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.kind} ${token.value}`);
  }
}

function valueOf(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value.fields)) out[key] = valueOf(child, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- execution

interface Ctx {
  store: Store;
  errors: Array<{ message: string }>;
  fragments: Record<string, FragmentDef>;
  variables: Record<string, unknown>;
}

type ObjValue = { __type: string; value: unknown } | null;

const ISSUE_TYPE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'resourcePath'];
const PULL_TYPE_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'url'];
const REPO_TYPE_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt', 'url'];
const SEARCH_ENUM_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'LABEL'];

function findRepoById(store: Store, databaseId: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === databaseId) return repo;
  return undefined;
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullMergeable(store: Store, repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
  return mergeConflicts(repo, headTip, baseTip) ? 'CONFLICTING' : 'MERGEABLE';
}

function issueFiles(repo: Repo, pull: Pull): string[] {
  const base = mergeBase(repo, pull.headSha, pull.baseSha);
  const baseTree = base === null ? null : treeAt(repo, base);
  const headTree = treeAt(repo, pull.headSha);
  return diffTrees(repo, baseTree ?? null, headTree ?? null)
    .filter((change) => change.status !== 'removed')
    .map((change) => change.path);
}

function issueConnection(repo: Repo, args: Record<string, unknown>): { __type: string; value: { repo: Repo; nodes: Array<{ repo: Repo; issue: Issue }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } {
  const first = typeof args.first === 'number' ? args.first : undefined;
  const after = typeof args.after === 'string' ? args.after : null;
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  let items = [...repo.issues];
  if (states !== null) {
    const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : state.toLowerCase())));
    items = items.filter((issue) => wanted.has(issue.state));
  }
  const direction = orderBy?.direction === 'ASC' ? 'asc' : orderBy?.direction === 'DESC' ? 'desc' : 'asc';
  items.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  let startIndex = 0;
  if (after !== null) {
    try {
      const text = Buffer.from(after, 'base64').toString('utf8');
      const match = /^cursor:(\d+)$/.exec(text);
      if (match !== null) {
        const last = parseInt(match[1]!, 10);
        const index = items.findIndex((issue) => issue.number === last);
        if (index >= 0) startIndex = index + 1;
      }
    } catch {
      // An undecodable cursor starts from the beginning.
    }
  }
  const page = first === undefined ? items.slice(startIndex) : items.slice(startIndex, startIndex + first);
  const hasNextPage = startIndex + page.length < items.length;
  const endCursor = page.length > 0 ? Buffer.from(`cursor:${page[page.length - 1]!.number}`, 'utf8').toString('base64') : null;
  return { __type: 'IssueConnection', value: { repo, nodes: page.map((issue) => ({ repo, issue })), pageInfo: { hasNextPage, endCursor } } };
}

function resolveField(ctx: Ctx, parentType: string, parent: unknown, field: FieldSelection): unknown {
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) args[key] = valueOf(value, ctx.variables);

  const fail = (message: string): null => {
    ctx.errors.push({ message });
    return null;
  };

  if (field.name === '__typename') return parentType;

  switch (parentType) {
    case 'Query': {
      if (field.name === 'viewer') return { __type: 'User', value: { login: VIEWER.login } };
      if (field.name === 'repository') {
        const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        if (repo === undefined) return null;
        return { __type: 'Repository', value: repo };
      }
      if (field.name === 'node') {
        const parsed = parseGlobalId(String(args.id ?? ''));
        if (parsed === null) return null;
        if (parsed.kind === 'Repository') {
          const repo = findRepoById(ctx.store, Number(parsed.parts[0]));
          return repo === undefined ? null : { __type: 'Repository', value: repo };
        }
        if (parsed.kind === 'Issue') {
          const repo = findRepoById(ctx.store, Number(parsed.parts[0]));
          const issue = repo?.issues.find((candidate) => candidate.number === Number(parsed.parts[1]));
          return issue === undefined || repo === undefined ? null : { __type: 'Issue', value: { repo, issue } };
        }
        if (parsed.kind === 'PullRequest') {
          const repo = findRepoById(ctx.store, Number(parsed.parts[0]));
          const pull = repo?.pulls.find((candidate) => candidate.number === Number(parsed.parts[1]));
          return pull === undefined || repo === undefined ? null : { __type: 'PullRequest', value: { repo, pull } };
        }
        return null;
      }
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        if (name === 'Issue') return { __type: '__Type', value: { name: 'Issue', fields: ISSUE_TYPE_FIELDS, enumValues: null } };
        if (name === 'PullRequest') return { __type: '__Type', value: { name: 'PullRequest', fields: PULL_TYPE_FIELDS, enumValues: null } };
        if (name === 'Repository') return { __type: '__Type', value: { name: 'Repository', fields: REPO_TYPE_FIELDS, enumValues: null } };
        if (name === 'SearchType') return { __type: '__Type', value: { name: 'SearchType', fields: null, enumValues: SEARCH_ENUM_VALUES } };
        return null;
      }
      return fail(`Cannot query field "${field.name}" on type "Query".`);
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.repositoryId ?? ''));
        if (parsed === null || parsed.kind !== 'Repository') return fail('createIssue: repositoryId is not a repository id');
        const repo = findRepoById(ctx.store, Number(parsed.parts[0]));
        if (repo === undefined) return fail('createIssue: repository not found');
        const issue = createIssue(ctx.store, repo, String(input.title ?? ''), String(input.body ?? ''), []);
        return { __type: 'CreateIssuePayload', value: { issue: { repo, issue } } };
      }
      if (field.name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.issueId ?? ''));
        if (parsed === null || parsed.kind !== 'Issue') return fail('closeIssue: issueId is not an issue id');
        const repo = findRepoById(ctx.store, Number(parsed.parts[0]));
        const issue = repo?.issues.find((candidate) => candidate.number === Number(parsed.parts[1]));
        if (issue === undefined || repo === undefined) return fail('closeIssue: issue not found');
        issue.state = 'closed';
        return { __type: 'CloseIssuePayload', value: { issue: { repo, issue } } };
      }
      if (field.name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.repositoryId ?? ''));
        if (parsed === null || parsed.kind !== 'Repository') return fail('createPullRequest: repositoryId is not a repository id');
        const repo = findRepoById(ctx.store, Number(parsed.parts[0]));
        if (repo === undefined) return fail('createPullRequest: repository not found');
        const created = createPull(ctx.store, repo, String(input.headRefName ?? ''), String(input.baseRefName ?? ''), String(input.title ?? ''), '');
        if (typeof created === 'object' && 'error' in created) return fail(`createPullRequest: ${created.error}`);
        return { __type: 'CreatePullRequestPayload', value: { pullRequest: { repo, pull: created } } };
      }
      if (field.name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
        if (parsed === null || parsed.kind !== 'PullRequest') return fail('mergePullRequest: pullRequestId is not a pull request id');
        const repo = findRepoById(ctx.store, Number(parsed.parts[0]));
        const pull = repo?.pulls.find((candidate) => candidate.number === Number(parsed.parts[1]));
        if (pull === undefined || repo === undefined) return fail('mergePullRequest: pull request not found');
        if (pull.state !== 'open') return fail('mergePullRequest: pull request is not open');
        const merged = squashMerge(ctx.store, repo, pull);
        if (merged === null) return fail('mergePullRequest: merge conflict');
        return { __type: 'MergePullRequestPayload', value: { pullRequest: { repo, pull } } };
      }
      if (field.name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parsed = parseGlobalId(String(input.subjectId ?? ''));
        if (parsed === null || parsed.kind !== 'Issue') return fail('addComment: subjectId is not an issue id');
        const repo = findRepoById(ctx.store, Number(parsed.parts[0]));
        const issue = repo?.issues.find((candidate) => candidate.number === Number(parsed.parts[1]));
        if (issue === undefined || repo === undefined) return fail('addComment: issue not found');
        const comment = { id: ctx.store.nextCommentId++, body: String(input.body ?? '') };
        issue.comments.push(comment);
        return { __type: 'AddCommentPayload', value: { commentEdge: { node: { id: globalId('IssueComment', repo.id, issue.number, comment.id), body: comment.body } } } };
      }
      return fail(`Cannot query field "${field.name}" on type "Mutation".`);
    }
    case 'User': {
      if (field.name === 'login') return VIEWER.login;
      return fail(`Cannot query field "${field.name}" on type "User".`);
    }
    case 'Repository': {
      const repo = parent as Repo;
      switch (field.name) {
        case 'id': return globalId('Repository', repo.id);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return { __type: 'User', value: { login: repo.owner } };
        case 'defaultBranchRef': {
          const tip = branchTip(repo, repo.defaultBranch);
          return tip === undefined ? null : { __type: 'Ref', value: { name: repo.defaultBranch } };
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'description': return repo.description;
        case 'private': return repo.private;
        case 'issue': {
          const issue = repo.issues.find((candidate) => candidate.number === Number(args.number));
          return issue === undefined ? null : { __type: 'Issue', value: { repo, issue } };
        }
        case 'issues': return issueConnection(repo, args);
        case 'pullRequests': {
          const first = typeof args.first === 'number' ? args.first : undefined;
          const nodes = [...repo.pulls].sort((a, b) => b.seq - a.seq);
          const page = first === undefined ? nodes : nodes.slice(0, first);
          return { __type: 'PullRequestConnection', value: { nodes: page.map((pull) => ({ repo, pull })) } };
        }
        case 'pullRequest': {
          const pull = repo.pulls.find((candidate) => candidate.number === Number(args.number));
          return pull === undefined ? null : { __type: 'PullRequest', value: { repo, pull } };
        }
        default: return fail(`Cannot query field "${field.name}" on type "Repository".`);
      }
    }
    case 'Ref': {
      const ref = parent as { name: string };
      if (field.name === 'name') return ref.name;
      return fail(`Cannot query field "${field.name}" on type "Ref".`);
    }
    case 'Issue': {
      const { repo, issue } = parent as { repo: Repo; issue: Issue };
      switch (field.name) {
        case 'id': return globalId('Issue', repo.id, issue.number);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issueState(issue);
        case 'body': return issue.body;
        default: return fail(`Cannot query field "${field.name}" on type "Issue".`);
      }
    }
    case 'IssueConnection': {
      const connection = parent as { repo: Repo; nodes: Array<{ repo: Repo; issue: Issue }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      if (field.name === 'nodes') return connection.nodes;
      if (field.name === 'pageInfo') return { __type: 'PageInfo', value: connection.pageInfo };
      return fail(`Cannot query field "${field.name}" on type "IssueConnection".`);
    }
    case 'PageInfo': {
      const info = parent as { hasNextPage: boolean; endCursor: string | null };
      if (field.name === 'hasNextPage') return info.hasNextPage;
      if (field.name === 'endCursor') return info.endCursor;
      return fail(`Cannot query field "${field.name}" on type "PageInfo".`);
    }
    case 'PullRequestConnection': {
      const connection = parent as { nodes: Array<{ repo: Repo; pull: Pull }> };
      if (field.name === 'nodes') return connection.nodes;
      return fail(`Cannot query field "${field.name}" on type "PullRequestConnection".`);
    }
    case 'PullRequest': {
      const { repo, pull } = parent as { repo: Repo; pull: Pull };
      switch (field.name) {
        case 'id': return globalId('PullRequest', repo.id, pull.number);
        case 'number': return pull.number;
        case 'state': return pullState(pull);
        case 'merged': return pull.merged;
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'mergeable': return pullMergeable(ctx.store, repo, pull);
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'files': {
          const paths = issueFiles(repo, pull);
          const first = typeof args.first === 'number' ? args.first : undefined;
          const page = first === undefined ? paths : paths.slice(0, first);
          return { __type: 'PullRequestChangedFileConnection', value: { nodes: page.map((path) => ({ path })) } };
        }
        default: return fail(`Cannot query field "${field.name}" on type "PullRequest".`);
      }
    }
    case 'PullRequestChangedFileConnection': {
      const connection = parent as { nodes: Array<{ path: string }> };
      if (field.name === 'nodes') return connection.nodes;
      return fail(`Cannot query field "${field.name}" on type "PullRequestChangedFileConnection".`);
    }
    case 'PullRequestChangedFile': {
      const file = parent as { path: string };
      if (field.name === 'path') return file.path;
      return fail(`Cannot query field "${field.name}" on type "PullRequestChangedFile".`);
    }
    case 'CreateIssuePayload': {
      const payload = parent as { issue: { repo: Repo; issue: Issue } };
      if (field.name === 'issue') return { __type: 'Issue', value: payload.issue };
      return fail(`Cannot query field "${field.name}" on type "CreateIssuePayload".`);
    }
    case 'CloseIssuePayload': {
      const payload = parent as { issue: { repo: Repo; issue: Issue } };
      if (field.name === 'issue') return { __type: 'Issue', value: payload.issue };
      return fail(`Cannot query field "${field.name}" on type "CloseIssuePayload".`);
    }
    case 'CreatePullRequestPayload': {
      const payload = parent as { pullRequest: { repo: Repo; pull: Pull } };
      if (field.name === 'pullRequest') return { __type: 'PullRequest', value: payload.pullRequest };
      return fail(`Cannot query field "${field.name}" on type "CreatePullRequestPayload".`);
    }
    case 'MergePullRequestPayload': {
      const payload = parent as { pullRequest: { repo: Repo; pull: Pull } };
      if (field.name === 'pullRequest') return { __type: 'PullRequest', value: payload.pullRequest };
      return fail(`Cannot query field "${field.name}" on type "MergePullRequestPayload".`);
    }
    case 'AddCommentPayload': {
      const payload = parent as { commentEdge: { node: { id: string; body: string } } };
      if (field.name === 'commentEdge') return { __type: 'CommentEdge', value: payload.commentEdge };
      return fail(`Cannot query field "${field.name}" on type "AddCommentPayload".`);
    }
    case 'CommentEdge': {
      const edge = parent as { node: { id: string; body: string } };
      if (field.name === 'node') return { __type: 'IssueComment', value: edge.node };
      return fail(`Cannot query field "${field.name}" on type "CommentEdge".`);
    }
    case 'IssueComment': {
      const comment = parent as { id: string; body: string };
      if (field.name === 'id') return comment.id;
      if (field.name === 'body') return comment.body;
      return fail(`Cannot query field "${field.name}" on type "IssueComment".`);
    }
    case '__Type': {
      const type = parent as { name: string; fields: string[] | null; enumValues: string[] | null };
      if (field.name === 'name') return type.name;
      if (field.name === 'fields') {
        if (type.fields === null) return null;
        return type.fields.map((name) => ({ __type: '__Field', value: { name } }));
      }
      if (field.name === 'enumValues') {
        if (type.enumValues === null) return null;
        return type.enumValues.map((name) => ({ __type: '__EnumValue', value: { name } }));
      }
      return fail(`Cannot query field "${field.name}" on type "__Type".`);
    }
    case '__Field': {
      const f = parent as { name: string };
      if (field.name === 'name') return f.name;
      return fail(`Cannot query field "${field.name}" on type "__Field".`);
    }
    case '__EnumValue': {
      const e = parent as { name: string };
      if (field.name === 'name') return e.name;
      return fail(`Cannot query field "${field.name}" on type "__EnumValue".`);
    }
    default:
      return fail(`Cannot query field "${field.name}" on type "${parentType}".`);
  }
}

/** Unwrap a resolver's object wrapper (or pass scalars through). */
function unwrap(value: unknown): { type: string | null; value: unknown } {
  if (value !== null && typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
    const wrapper = value as { __type: string; value: unknown };
    return { type: wrapper.__type, value: wrapper.value };
  }
  return { type: null, value };
}

/** The item type of a connection/list's nodes, for node wrapping. */
function nodeTypeOf(parentType: string, fieldName: string): string | null {
  if (parentType === 'IssueConnection' && fieldName === 'nodes') return 'Issue';
  if (parentType === 'PullRequestConnection' && fieldName === 'nodes') return 'PullRequest';
  if (parentType === 'PullRequestChangedFileConnection' && fieldName === 'nodes') return 'PullRequestChangedFile';
  if (parentType === '__Type' && fieldName === 'fields') return '__Field';
  if (parentType === '__Type' && fieldName === 'enumValues') return '__EnumValue';
  return null;
}

function execSelections(ctx: Ctx, selections: Selection[], parentType: string, parent: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments[selection.name];
      if (fragment !== undefined) Object.assign(out, execSelections(ctx, fragment.selections, parentType, parent));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === parentType) {
        Object.assign(out, execSelections(ctx, selection.selections, parentType, parent));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    const resolved = resolveField(ctx, parentType, parent, selection);
    if (selection.selections.length === 0) {
      const { value } = unwrap(resolved);
      out[key] = value;
      continue;
    }
    // Object or list with sub-selections.
    const { type, value } = unwrap(resolved);
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (Array.isArray(value)) {
      const itemType = nodeTypeOf(parentType, selection.name);
      out[key] = value.map((item) => {
        if (itemType === null) return item;
        const { type: itemInnerType, value: itemValue } = unwrap(item);
        const effectiveType = itemInnerType ?? itemType;
        return execSelections(ctx, selection.selections, effectiveType, itemValue);
      });
      continue;
    }
    const effectiveType = type ?? parentType;
    out[key] = execSelections(ctx, selection.selections, effectiveType, value);
  }
  return out;
}

function executeOperation(store: Store, doc: Document, operation: Operation, variables: Record<string, unknown>): { data: Record<string, unknown>; errors?: Array<{ message: string }> } {
  const ctx: Ctx = { store, errors: [], fragments: doc.fragments, variables };
  // Apply variable defaults.
  for (const [name, def] of Object.entries(operation.variableDefs)) {
    if (ctx.variables[name] === undefined && def.default !== undefined) ctx.variables[name] = valueOf(def.default, {});
  }
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = execSelections(ctx, operation.selections, rootType, null);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

function executeOne(store: Store, body: unknown): { status: number; payload: unknown } {
  if (Array.isArray(body)) {
    const results = body.map((entry) => executeSingle(store, entry));
    return { status: 200, payload: results };
  }
  return { status: 200, payload: executeSingle(store, body) };
}

function executeSingle(store: Store, body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { errors: [{ message: 'the request body must be a JSON object with a query string' }] };
  }
  const record = body as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { errors: [{ message: 'no query string was provided' }] };
  }
  const variables = (record.variables ?? {}) as Record<string, unknown>;
  let doc: Document;
  try {
    doc = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: `GraphQL syntax error: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  if (doc.operations.length === 0) return { errors: [{ message: 'the document holds no operation' }] };
  const operationName = typeof record.operationName === 'string' ? record.operationName : null;
  let operation = doc.operations[0]!;
  if (operationName !== null) {
    const named = doc.operations.find((candidate) => candidate.name === operationName);
    if (named !== undefined) operation = named;
  }
  return executeOperation(store, doc, operation, { ...variables });
}

/** The GraphQL v4 handler at POST /api/graphql. */
export async function handleGraphql(store: Store, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!hasBearer(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  const buf = await readBody(req);
  const parsed = parseJsonBody(buf);
  if (!parsed.ok) {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return true;
  }
  const { payload } = executeOne(store, parsed.value);
  sendJson(res, 200, payload);
  return true;
}
