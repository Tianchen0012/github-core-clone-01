// mcp.ts — the Model Context Protocol endpoint at POST /mcp (Streamable HTTP,
// JSON-RPC 2.0). The modern 2026-07-28 era is served (server/discover, no
// handshake), with the legacy initialize handshake as a fallback. Every
// request needs the bearer token; tools act on the same store as REST.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER,
  branchTip,
  createIssue,
  createPull,
  globalId,
  mergeConflicts,
  squashMerge,
  type Repo,
  type Store,
} from './store.ts';
import { hasBearer, parseJsonBody, readBody, sendJson } from './util.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** The tool list, built once: two tools/list calls answer byte-identical JSON. */
const TOOLS = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'The repository name.' }),
        description: Object.freeze({ type: 'string', description: 'A short description of the repository.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
        owner: Object.freeze({ type: 'string', description: 'The owner login; defaults to the authenticated user.' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The issue title.' }),
        body: Object.freeze({ type: 'string', description: 'The issue body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        state: Object.freeze({ type: 'string', description: 'open, closed or all.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The pull request title.' }),
        body: Object.freeze({ type: 'string', description: 'The pull request body.' }),
        head: Object.freeze({ type: 'string', description: 'The head branch name.' }),
        base: Object.freeze({ type: 'string', description: 'The base branch name.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        pull_number: Object.freeze({ type: 'integer', description: 'The pull request number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function repoObject(repo: Repo): Json {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function okResult(value: Json): Json {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function errorResult(message: string): Json {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Run one tool; returns its result object (or an isError result). */
function callTool(store: Store, name: string, args: Json): Json {
  const owner = str(args.owner) || VIEWER.login;
  const repoName = str(args.repo ?? args.name);
  switch (name) {
    case 'create_repo': {
      const repoNameArg = str(args.name);
      if (repoNameArg === '') return errorResult('missing required argument: name');
      const created = store.createRepo(owner, repoNameArg, {
        description: str(args.description),
        private: typeof args.private === 'boolean' ? args.private : false,
      });
      if (created === null) return errorResult(`repository ${owner}/${repoNameArg} already exists`);
      return okResult(repoObject(created));
    }
    case 'get_repo': {
      if (repoName === '') return errorResult('missing required argument: repo');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return errorResult(`repository ${owner}/${repoName} not found`);
      return okResult(repoObject(repo));
    }
    case 'create_issue': {
      const title = str(args.title);
      if (repoName === '' || title === '') return errorResult('missing required argument: repo or title');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return errorResult(`repository ${owner}/${repoName} not found`);
      const issue = createIssue(store, repo, title, str(args.body), []);
      return okResult({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        repository: `${repo.owner}/${repo.name}`,
      });
    }
    case 'list_issues': {
      if (repoName === '') return errorResult('missing required argument: repo');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return errorResult(`repository ${owner}/${repoName} not found`);
      const state = str(args.state) || 'open';
      const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      return okResult({
        issues: issues.map((issue) => ({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state })),
      });
    }
    case 'create_pull_request': {
      const title = str(args.title);
      const head = str(args.head);
      const base = str(args.base) || 'main';
      if (repoName === '' || title === '' || head === '') return errorResult('missing required argument: repo, title or head');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return errorResult(`repository ${owner}/${repoName} not found`);
      const created = createPull(store, repo, head, base, title, str(args.body));
      if (typeof created === 'object' && 'error' in created) return errorResult(`cannot create pull request: ${created.error}`);
      return okResult({
        id: created.id,
        number: created.number,
        title: created.title,
        state: created.state,
        head: { ref: created.headRef, sha: created.headSha },
        base: { ref: created.baseRef, sha: created.baseSha },
      });
    }
    case 'merge_pull_request': {
      const number = typeof args.pull_number === 'number' ? args.pull_number : parseInt(str(args.pull_number), 10);
      if (repoName === '' || !Number.isFinite(number)) return errorResult('missing required argument: repo or pull_number');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return errorResult(`repository ${owner}/${repoName} not found`);
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (pull === undefined) return errorResult(`pull request #${number} not found`);
      if (pull.state !== 'open') return errorResult(`pull request #${number} is not open`);
      const headTip = branchTip(repo, pull.headRef);
      const baseTip = branchTip(repo, pull.baseRef);
      if (headTip === undefined || baseTip === undefined) return errorResult('head or base branch not found');
      if (mergeConflicts(repo, headTip, baseTip)) return errorResult('merge conflict');
      const sha = squashMerge(store, repo, pull);
      if (sha === null) return errorResult('merge conflict');
      return okResult({ merged: true, number: pull.number, sha, message: `Pull request #${pull.number} merged` });
    }
    default:
      return errorResult(`unknown tool ${name}`);
  }
}

/** The MCP handler at POST /mcp. Returns true when the path was /mcp. */
export async function handleMcp(store: Store, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = req.url ?? '';
  if (path !== '/mcp' && !path.startsWith('/mcp?')) return false;

  // A legacy session close: best-effort DELETE, answered 204.
  if ((req.method ?? 'GET') === 'DELETE') {
    res.writeHead(204);
    res.end();
    return true;
  }
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not found' } });
    return true;
  }

  const buf = await readBody(req);
  const parsed = parseJsonBody(buf);
  if (!parsed.ok) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  const body = parsed.value;
  if (!isRecord(body)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }

  const id = body.id === undefined ? null : (body.id as string | number | null);
  const method = typeof body.method === 'string' ? body.method : '';

  // Notifications (no id) are acknowledged with an empty 202.
  if (id === null && body.id === undefined) {
    res.writeHead(202);
    res.end();
    return true;
  }

  // Authentication is decided before any method runs.
  if (!hasBearer(req)) {
    sendJson(res, 401, { jsonrpc: '2.0', id, error: { code: -32001, message: 'Unauthorized' } });
    return true;
  }

  const params = isRecord(body.params) ? body.params : {};
  const reply = (result: unknown, extraHeaders: Record<string, string> = {}): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, result }, extraHeaders);
  };
  const replyError = (code: number, message: string, status = 200): void => {
    sendJson(res, status, { jsonrpc: '2.0', id, error: { code, message } });
  };

  switch (method) {
    case 'server/discover': {
      reply({
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      });
      return true;
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      reply(
        {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
        { 'mcp-session-id': 'mcp-session-1' },
      );
      return true;
    }
    case 'ping': {
      reply({});
      return true;
    }
    case 'tools/list': {
      reply({ tools: TOOLS });
      return true;
    }
    case 'tools/call': {
      const toolName = str(params.name);
      const args = isRecord(params.arguments) ? params.arguments : {};
      const known = TOOLS.some((tool) => tool.name === toolName);
      if (!known) {
        replyError(-32602, `Unknown tool: ${toolName}`);
        return true;
      }
      const result = callTool(store, toolName, args);
      reply(result);
      return true;
    }
    default: {
      replyError(-32601, `Method not found: ${method}`);
      return true;
    }
  }
}
