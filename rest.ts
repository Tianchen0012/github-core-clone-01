// rest.ts — the GitHub REST v3 surface under /api/v3.
//
// Every reply is application/json with a non-empty X-GitHub-Request-Id.
// Errors are JSON {"message": string}. Every route requires a non-empty
// Bearer token; any such token is the viewer (adaiversen).

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  FIXED_ISO,
  VIEWER,
  branchTip,
  createIssue,
  createPull,
  deleteContents,
  diffTrees,
  globalId,
  lineDiff,
  listBranches,
  listCommits,
  listDirAt,
  mergeBase,
  mergeConflicts,
  readFileAt,
  refName,
  squashMerge,
  treeAt,
  writeContents,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { decodeSegment, hasBearer, parseJsonBody, pathOf, queryOf, readBody, sendJson } from './util.ts';

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function intParam(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

function userObject(): Json {
  return { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' };
}

function repoObject(repo: Repo): Json {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 0, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    has_issues: true,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

function issueObject(store: Store, repo: Repo, issue: Issue): Json {
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: VIEWER.login },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

function pullObject(repo: Repo, pull: Pull): Json {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER.login },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

function notFound(res: ServerResponse, what = 'Not Found'): void {
  sendJson(res, 404, { message: what });
}

function badRequest(res: ServerResponse, what: string): void {
  sendJson(res, 400, { message: what });
}

/** The repository a route names, or null (with the 404 already sent). */
function loadRepo(store: Store, res: ServerResponse, owner: string, name: string): Repo | null {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) {
    notFound(res, 'Not Found');
    return null;
  }
  return repo;
}

/** Read and parse a JSON request body; sends 400 on malformed JSON. */
async function readJson(req: IncomingMessage, res: ServerResponse): Promise<Json | null | undefined> {
  const buf = await readBody(req);
  const parsed = parseJsonBody(buf);
  if (!parsed.ok) {
    badRequest(res, 'Problems parsing JSON');
    return undefined;
  }
  const value = parsed.value;
  if (value !== undefined && !isRecord(value)) {
    badRequest(res, 'Problems parsing JSON');
    return undefined;
  }
  return (value ?? null) as Json | null;
}

/** The REST v3 handler. Returns true when the path was under /api/v3. */
export async function handleRest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = pathOf(req);
  if (path !== '/api/v3' && !path.startsWith('/api/v3/')) return false;
  if (!hasBearer(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  const method = req.method ?? 'GET';
  const tail = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
  const segments = tail === '' ? [] : tail.split('/').map(decodeSegment);
  const query = queryOf(req);

  // GET /api/v3/ — the API root.
  if (segments.length === 0) {
    if (method !== 'GET') {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }

  // GET /api/v3/user — the token's owner.
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    sendJson(res, 200, userObject());
    return true;
  }

  // /api/v3/user/repos — list (GET) and create (POST).
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const all = store.listRepos(VIEWER.login);
      const perPage = Math.min(100, intParam(query, 'per_page', 30));
      const page = intParam(query, 'page', 1);
      const start = (page - 1) * perPage;
      const items = all.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      const totalPages = Math.max(1, Math.ceil(all.length / perPage));
      if (page < totalPages) {
        const base = `${originOf(req)}/api/v3/user/repos`;
        const links = [
          `<${base}?page=${page + 1}&per_page=${perPage}>; rel="next"`,
          `<${base}?page=1&per_page=${perPage}>; rel="first"`,
          `<${base}?page=${totalPages}&per_page=${perPage}>; rel="last"`,
        ];
        headers.link = links.join(', ');
      }
      sendJson(res, 200, items.map(repoObject), headers);
      return true;
    }
    if (method === 'POST') {
      const body = await readJson(req, res);
      if (body === undefined) return true;
      const name = str(body?.name ?? null);
      if (name === '') {
        sendJson(res, 422, { message: 'Validation Failed: name is required' });
        return true;
      }
      const created = store.createRepo(VIEWER.login, name, {
        description: str(body?.description ?? null),
        private: bool(body?.private ?? null, false),
      });
      if (created === null) {
        sendJson(res, 422, { message: 'Validation Failed: name already exists on this account' });
        return true;
      }
      sendJson(res, 201, repoObject(created));
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1]!;
    const name = segments[2]!;
    const rest = segments.slice(3);
    return handleRepoRoute(store, req, res, method, owner, name, rest, query);
  }

  sendJson(res, 404, { message: 'Not Found' });
  return true;
}

async function handleRepoRoute(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  owner: string,
  name: string,
  rest: string[],
  query: URLSearchParams,
): Promise<boolean> {
  // GET /repos/{o}/{r}, PATCH, DELETE
  if (rest.length === 0) {
    if (method === 'GET') {
      const repo = loadRepo(store, res, owner, name);
      if (repo === null) return true;
      sendJson(res, 200, repoObject(repo));
      return true;
    }
    if (method === 'PATCH') {
      const repo = loadRepo(store, res, owner, name);
      if (repo === null) return true;
      const body = await readJson(req, res);
      if (body === undefined) return true;
      if (typeof body?.description === 'string') repo.description = body.description;
      if (typeof body?.private === 'boolean') repo.private = body.private;
      sendJson(res, 200, repoObject(repo));
      return true;
    }
    if (method === 'DELETE') {
      const repo = loadRepo(store, res, owner, name);
      if (repo === null) return true;
      store.deleteRepo(owner, name);
      sendJson(res, 204, null);
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  // Branches
  if (rest[0] === 'branches') {
    const repo = loadRepo(store, res, owner, name);
    if (repo === null) return true;
    if (rest.length === 1) {
      if (method !== 'GET') {
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      sendJson(res, 200, listBranches(repo).map((branch) => ({ name: branch.name, commit: { sha: branch.sha } })));
      return true;
    }
    const branch = rest.slice(1).join('/');
    const tip = branchTip(repo, branch);
    if (tip === undefined) {
      notFound(res, 'Branch not found');
      return true;
    }
    if (method !== 'GET') {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    sendJson(res, 200, { name: branch, commit: { sha: tip } });
    return true;
  }

  // Commits
  if (rest[0] === 'commits' && rest.length === 1) {
    const repo = loadRepo(store, res, owner, name);
    if (repo === null) return true;
    if (method !== 'GET') {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    const ref = query.get('sha') ?? repo.defaultBranch;
    const commits = listCommits(repo, ref);
    sendJson(
      res,
      200,
      commits.map((entry) => ({ sha: entry.sha, commit: { message: entry.message } })),
    );
    return true;
  }

  // Git Data: refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    const repo = loadRepo(store, res, owner, name);
    if (repo === null) return true;
    if (method === 'POST' && rest.length === 2) {
      const body = await readJson(req, res);
      if (body === undefined) return true;
      const ref = str(body?.ref ?? null);
      const sha = str(body?.sha ?? null);
      if (!ref.startsWith('refs/heads/') || !/^[0-9a-f]{40}$/.test(sha)) {
        sendJson(res, 422, { message: 'Validation Failed' });
        return true;
      }
      if (repo.refs.has(ref)) {
        sendJson(res, 422, { message: 'Validation Failed: Reference already exists' });
        return true;
      }
      const object = repo.objects.get(sha);
      if (object === undefined || object.type !== 'commit') {
        sendJson(res, 422, { message: 'Validation Failed: Object does not exist' });
        return true;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha } });
      return true;
    }
    if (method === 'GET' && rest.length >= 4 && rest[2] === 'heads') {
      const branch = rest.slice(3).join('/');
      const tip = branchTip(repo, branch);
      if (tip === undefined) {
        notFound(res, 'Not Found');
        return true;
      }
      sendJson(res, 200, { ref: refName(branch), object: { sha: tip } });
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  // Contents
  if (rest[0] === 'contents') {
    const repo = loadRepo(store, res, owner, name);
    if (repo === null) return true;
    const filePath = rest.slice(1).join('/');
    if (filePath === '') {
      // The repository root: list it on GET, 404 for anything else.
      if (method === 'GET') {
        const ref = query.get('ref') ?? repo.defaultBranch;
        const dir = listDirAt(repo, ref, '');
        if (dir !== null) {
          sendJson(res, 200, dir);
          return true;
        }
      }
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    if (method === 'GET') {
      const ref = query.get('ref') ?? repo.defaultBranch;
      const file = readFileAt(repo, ref, filePath);
      if (file !== null) {
        sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          content: file.data.toString('base64'),
          sha: file.oid,
          size: file.data.length,
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
        });
        return true;
      }
      const dir = listDirAt(repo, ref, filePath);
      if (dir !== null) {
        sendJson(res, 200, dir);
        return true;
      }
      notFound(res, 'Not Found');
      return true;
    }
    if (method === 'PUT') {
      const body = await readJson(req, res);
      if (body === undefined) return true;
      const message = str(body?.message ?? null);
      const contentB64 = str(body?.content ?? null);
      const branch = str(body?.branch ?? null, repo.defaultBranch);
      const sha = typeof body?.sha === 'string' ? body.sha : undefined;
      if (contentB64 === '') {
        sendJson(res, 422, { message: 'Validation Failed: content is required' });
        return true;
      }
      const content = Buffer.from(contentB64, 'base64');
      const result = writeContents(repo, branch, filePath, content, message, sha);
      if (!result.ok) {
        if (result.reason === 'stale') sendJson(res, 409, { message: 'Conflict: sha does not match' });
        else sendJson(res, 422, { message: 'Validation Failed' });
        return true;
      }
      sendJson(res, result.created ? 201 : 200, {
        content: { sha: result.contentSha, encoding: 'base64' },
        commit: { sha: result.commitSha },
      });
      return true;
    }
    if (method === 'DELETE') {
      const body = await readJson(req, res);
      if (body === undefined) return true;
      const message = str(body?.message ?? null);
      const sha = typeof body?.sha === 'string' ? body.sha : undefined;
      const branch = str(body?.branch ?? null, repo.defaultBranch);
      const result = deleteContents(repo, branch, filePath, message, sha);
      if (!result.ok) {
        if (result.reason === 'stale') sendJson(res, 409, { message: 'Conflict: sha does not match' });
        else notFound(res, 'Not Found');
        return true;
      }
      sendJson(res, 200, { commit: { sha: result.commitSha } });
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  // Labels
  if (rest[0] === 'labels') {
    const repo = loadRepo(store, res, owner, name);
    if (repo === null) return true;
    if (method === 'GET' && rest.length === 1) {
      sendJson(res, 200, [...repo.labels.values()]);
      return true;
    }
    if (method === 'POST' && rest.length === 1) {
      const body = await readJson(req, res);
      if (body === undefined) return true;
      const labelName = str(body?.name ?? null);
      if (labelName === '') {
        sendJson(res, 422, { message: 'Validation Failed: name is required' });
        return true;
      }
      const color = str(body?.color ?? null, 'ededed');
      const label = { name: labelName, color };
      repo.labels.set(labelName, label);
      sendJson(res, 201, label);
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  // Issues
  if (rest[0] === 'issues') {
    return handleIssues(store, req, res, method, owner, name, rest.slice(1), query);
  }

  // Pull requests
  if (rest[0] === 'pulls') {
    return handlePulls(store, req, res, method, owner, name, rest.slice(1), query);
  }

  sendJson(res, 404, { message: 'Not Found' });
  return true;
}

async function handleIssues(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  owner: string,
  name: string,
  rest: string[],
  query: URLSearchParams,
): Promise<boolean> {
  const repo = loadRepo(store, res, owner, name);
  if (repo === null) return true;

  // POST /issues and GET /issues
  if (rest.length === 0) {
    if (method === 'POST') {
      const body = await readJson(req, res);
      if (body === undefined) return true;
      const title = str(body?.title ?? null);
      const bodyText = str(body?.body ?? null);
      const labelsRaw = body?.labels;
      const labels: string[] = Array.isArray(labelsRaw)
        ? labelsRaw.map((entry) => (typeof entry === 'string' ? entry : str((entry as Json)?.name ?? null))).filter((entry) => entry !== '')
        : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) {
          sendJson(res, 422, { message: `Validation Failed: label "${label}" does not exist` });
          return true;
        }
      }
      if (title === '') {
        sendJson(res, 422, { message: 'Validation Failed: title is required' });
        return true;
      }
      const issue = createIssue(store, repo, title, bodyText, labels);
      sendJson(res, 201, issueObject(store, repo, issue));
      return true;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      const perPage = Math.min(100, intParam(query, 'per_page', 30));
      const page = intParam(query, 'page', 1);
      let items = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      if (sort === 'created') {
        items = [...items].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      const start = (page - 1) * perPage;
      sendJson(res, 200, items.slice(start, start + perPage).map((issue) => issueObject(store, repo, issue)));
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  const number = parseInt(rest[0]!, 10);
  if (!Number.isFinite(number)) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  const issue = repo.issues.find((candidate) => candidate.number === number);

  // Comments
  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === undefined) {
      notFound(res, 'Not Found');
      return true;
    }
    if (method === 'POST') {
      const body = await readJson(req, res);
      if (body === undefined) return true;
      const text = str(body?.body ?? null);
      const comment = { id: store.nextCommentId++, body: text };
      issue.comments.push(comment);
      sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: VIEWER.login }, created_at: FIXED_ISO });
      return true;
    }
    if (method === 'GET') {
      sendJson(
        res,
        200,
        issue.comments.map((comment) => ({ id: comment.id, body: comment.body, user: { login: VIEWER.login }, created_at: FIXED_ISO })),
      );
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  if (rest.length === 1) {
    if (method === 'GET') {
      if (issue === undefined) {
        notFound(res, 'Not Found');
        return true;
      }
      sendJson(res, 200, issueObject(store, repo, issue));
      return true;
    }
    if (method === 'PATCH') {
      if (issue === undefined) {
        notFound(res, 'Not Found');
        return true;
      }
      const body = await readJson(req, res);
      if (body === undefined) return true;
      if (typeof body?.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
      if (typeof body?.title === 'string') issue.title = body.title;
      if (typeof body?.body === 'string') issue.body = body.body;
      sendJson(res, 200, issueObject(store, repo, issue));
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  sendJson(res, 404, { message: 'Not Found' });
  return true;
}

async function handlePulls(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  owner: string,
  name: string,
  rest: string[],
  query: URLSearchParams,
): Promise<boolean> {
  const repo = loadRepo(store, res, owner, name);
  if (repo === null) return true;

  // POST /pulls and GET /pulls
  if (rest.length === 0) {
    if (method === 'POST') {
      const body = await readJson(req, res);
      if (body === undefined) return true;
      const head = str(body?.head ?? null);
      const base = str(body?.base ?? null, repo.defaultBranch);
      const title = str(body?.title ?? null);
      const bodyText = str(body?.body ?? null);
      if (head === '' || title === '') {
        sendJson(res, 422, { message: 'Validation Failed' });
        return true;
      }
      const created = createPull(store, repo, head, base, title, bodyText);
      if (typeof created === 'object' && 'error' in created) {
        const reason = created.error === 'duplicate' ? 'a pull request from this head already exists' : `branch ${created.error === 'no-head' ? head : base} does not exist`;
        sendJson(res, 422, { message: `Validation Failed: ${reason}` });
        return true;
      }
      sendJson(res, 201, pullObject(repo, created as Pull));
      return true;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const perPage = Math.min(100, intParam(query, 'per_page', 30));
      const page = intParam(query, 'page', 1);
      let items = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
      items = [...items].sort((a, b) => b.seq - a.seq);
      const start = (page - 1) * perPage;
      sendJson(res, 200, items.slice(start, start + perPage).map((pull) => pullObject(repo, pull)));
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  const number = parseInt(rest[0]!, 10);
  if (!Number.isFinite(number)) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  const pull = repo.pulls.find((candidate) => candidate.number === number);

  // GET /pulls/{n}/files
  if (rest.length === 2 && rest[1] === 'files') {
    if (pull === undefined) {
      notFound(res, 'Not Found');
      return true;
    }
    if (method !== 'GET') {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    const base = mergeBase(repo, pull.headSha, pull.baseSha);
    const baseTree = base === null ? null : treeAt(repo, base);
    const headTree = treeAt(repo, pull.headSha);
    const changes = diffTrees(repo, baseTree ?? null, headTree ?? null);
    const files = changes.map((change) => {
      const oldData = change.oldOid === null ? null : (repo.objects.get(change.oldOid)?.data ?? null);
      const newData = change.newOid === null ? null : (repo.objects.get(change.newOid)?.data ?? null);
      const counts = lineDiff(oldData, newData);
      const status = change.status === 'added' ? 'added' : change.status === 'removed' ? 'removed' : 'modified';
      return {
        filename: change.path,
        status,
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
      };
    });
    sendJson(res, 200, files);
    return true;
  }

  // PUT /pulls/{n}/merge
  if (rest.length === 2 && rest[1] === 'merge') {
    if (pull === undefined) {
      notFound(res, 'Not Found');
      return true;
    }
    if (method !== 'PUT') {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    const body = await readJson(req, res);
    if (body === undefined) return true;
    void body;
    if (pull.state === 'closed') {
      sendJson(res, 405, { message: 'Pull request is already closed' });
      return true;
    }
    const headTip = branchTip(repo, pull.headRef);
    const baseTip = branchTip(repo, pull.baseRef);
    if (headTip === undefined || baseTip === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    if (mergeConflicts(repo, headTip, baseTip)) {
      sendJson(res, 405, { message: 'Merge conflict' });
      return true;
    }
    const mergeSha = squashMerge(store, repo, pull);
    if (mergeSha === null) {
      sendJson(res, 405, { message: 'Merge conflict' });
      return true;
    }
    sendJson(res, 200, { merged: true, sha: mergeSha, message: `Pull request #${pull.number} merged` });
    return true;
  }

  // GET /pulls/{n}
  if (rest.length === 1) {
    if (method !== 'GET') {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    if (pull === undefined) {
      notFound(res, 'Not Found');
      return true;
    }
    sendJson(res, 200, pullObject(repo, pull));
    return true;
  }

  sendJson(res, 404, { message: 'Not Found' });
  return true;
}
