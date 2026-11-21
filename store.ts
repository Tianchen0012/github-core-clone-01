// store.ts — the forge's in-memory data model and its git-object operations.
//
// One Store holds every repository. A repository holds its git objects and
// refs plus its issues, pull requests and labels. All stored data is
// deterministic: REST-created commits use a fixed identity and a fixed
// timestamp, never the wall clock, so two runs of the same operations leave
// byte-identical state.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  makeObject,
  parseCommit,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './git.ts';

/** The login the trial's bearer token names (the seeded scenario's viewer). */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

/** Fixed timestamps for everything the forge itself creates (determinism). */
export const FIXED_EPOCH_SEC = 1735689600; // 2025-01-01T00:00:00Z
export const FIXED_ISO = '2025-01-01T00:00:00.000Z';
export const COMMIT_IDENT = `${VIEWER.name} <${VIEWER.email}> ${FIXED_EPOCH_SEC} +0000`;

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  id: number; // global numeric id, stable across reads
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number; // creation order, for sorting
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
}

export interface Label {
  name: string;
  color: string;
}

export interface Repo {
  id: number; // databaseId, global sequential
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // full ref name -> oid
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextIssue: number;
  nextPull: number;
  seq: number; // creation order, for listing
}

export class Store {
  readonly repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  nextCommentId = 1;
  nextSeq = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, opts: { description?: string; private?: boolean }): Repo | null {
    const key = this.key(owner, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssue: 1,
      nextPull: 1,
      seq: this.nextSeq++,
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }
}

// ---------------------------------------------------------------- global ids

/** An opaque Relay-style global id: base64 of "Kind:part:part". */
export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const pieces = text.split(':');
    const kind = pieces[0];
    if (kind === undefined || kind === '' || pieces.length < 2) return null;
    if (!/^[A-Za-z]+$/.test(kind)) return null;
    return { kind, parts: pieces.slice(1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- refs and trees

export function refName(branch: string): string {
  return `refs/heads/${branch}`;
}

export function branchOfRef(ref: string): string | null {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
}

/** Resolve a ref-ish (branch name, full ref, or commit oid) to a commit oid. */
export function resolveRef(repo: Repo, ref: string): string | undefined {
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  const asBranch = repo.refs.get(refName(ref));
  if (asBranch !== undefined) return asBranch;
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const object = repo.objects.get(ref);
    if (object !== undefined && object.type === 'commit') return ref;
  }
  return undefined;
}

/** The tip commit oid of a branch, or undefined. */
export function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(refName(branch));
}

/** All branches as {name, sha}, sorted by name. */
export function listBranches(repo: Repo): Array<{ name: string; sha: string }> {
  const out: Array<{ name: string; sha: string }> = [];
  for (const [ref, sha] of repo.refs) {
    const branch = branchOfRef(ref);
    if (branch !== null) out.push({ name: branch, sha });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** The tree oid of the commit at `ref`, or undefined. */
export function treeAt(repo: Repo, ref: string): string | undefined {
  const commitOid = resolveRef(repo, ref);
  if (commitOid === undefined) return undefined;
  const commit = repo.objects.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return undefined;
  return parseCommit(commit.data).tree;
}

/** Flatten a tree into path -> {oid, mode}, recursing into directories. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, base: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = base === '' ? entry.name : `${base}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** Read one file at a ref: its blob oid and bytes, or null when absent. */
export function readFileAt(repo: Repo, ref: string, path: string): { oid: string; data: Buffer } | null {
  const treeOid = treeAt(repo, ref);
  if (treeOid === undefined) return null;
  const flat = flattenTree(repo, treeOid);
  const found = flat.get(path);
  if (found === undefined) return null;
  const blob = repo.objects.get(found.oid);
  if (blob === undefined || blob.type !== 'blob') return null;
  return { oid: found.oid, data: blob.data };
}

/** List a directory at a ref: immediate children, or null when it is not a directory. */
export function listDirAt(
  repo: Repo,
  ref: string,
  dirPath: string,
): Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string }> | null {
  const treeOid = treeAt(repo, ref);
  if (treeOid === undefined) return null;
  const segments = dirPath === '' ? [] : dirPath.split('/');
  let current = treeOid;
  for (const segment of segments) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
    if (entry === undefined || entry.mode !== '40000') return null;
    current = entry.oid;
  }
  const object = repo.objects.get(current);
  if (object === undefined || object.type !== 'tree') return null;
  const out: Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string }> = [];
  for (const entry of parseTree(object.data)) {
    const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
    out.push({ type: entry.mode === '40000' ? 'dir' : 'file', name: entry.name, path, sha: entry.oid });
  }
  return out;
}

// ---------------------------------------------------------------- commits

function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const { oid, object } = makeObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, object);
  return oid;
}

/**
 * Rebuild the tree at `treeOid` (or an empty tree) with `path` set to
 * `blobOid` (or removed when null), creating/pruning intermediate trees.
 * Returns the new root tree oid.
 */
export function updateTree(repo: Repo, treeOid: string | null, path: string, blobOid: string | null): string {
  const segments = path.split('/');
  const build = (currentOid: string | null, depth: number): string | null => {
    const entries = new Map<string, TreeEntry>();
    if (currentOid !== null) {
      const object = repo.objects.get(currentOid);
      if (object !== undefined && object.type === 'tree') {
        for (const entry of parseTree(object.data)) entries.set(entry.name, entry);
      }
    }
    const name = segments[depth]!;
    if (depth === segments.length - 1) {
      if (blobOid === null) entries.delete(name);
      else entries.set(name, { mode: '100644', name, oid: blobOid });
    } else {
      const child = entries.get(name);
      const next = build(child !== undefined && child.mode === '40000' ? child.oid : null, depth + 1);
      if (next === null) entries.delete(name);
      else entries.set(name, { mode: '40000', name, oid: next });
    }
    if (entries.size === 0) return null;
    return putObject(repo, 'tree', buildTree([...entries.values()]));
  };
  return build(treeOid, 0) ?? putObject(repo, 'tree', buildTree([]));
}

/** Create a commit object on top of `parents` with `treeOid` and `message`. */
export function makeCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
  const text = message.endsWith('\n') ? message : `${message}\n`;
  return putObject(
    repo,
    'commit',
    buildCommit({ tree: treeOid, parents, author: COMMIT_IDENT, committer: COMMIT_IDENT, message: text }),
  );
}

export type ContentsResult =
  | { ok: true; commitSha: string; contentSha: string; created: boolean }
  | { ok: false; reason: 'stale' | 'not-found' | 'no-branch' };

/**
 * The contents API's write: set `path` to `content` on `branch` (creating
 * the branch from the default tip when it does not exist yet, or as the
 * repo's first branch when the repo is unborn). `sha`, when given, must be
 * the blob sha currently at the path, else the write is stale.
 */
export function writeContents(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
  sha?: string,
): ContentsResult {
  let tip = branchTip(repo, branch);
  if (tip === undefined) {
    // A missing branch is created from the default branch tip (or as the
    // first branch of an unborn repository).
    const defaultTip = branchTip(repo, repo.defaultBranch);
    if (defaultTip !== undefined) {
      repo.refs.set(refName(branch), defaultTip);
      tip = defaultTip;
    } else if (branch === repo.defaultBranch) {
      tip = undefined; // unborn: the commit below is the root
    } else {
      return { ok: false, reason: 'no-branch' };
    }
  }
  const currentTree = tip === undefined ? null : treeAt(repo, tip);
  const current = tip === undefined ? null : readFileAt(repo, tip, path);
  if (sha !== undefined) {
    if (current === null || current.oid !== sha) return { ok: false, reason: 'stale' };
  }
  const created = current === null;
  const blobOid = putObject(repo, 'blob', content);
  const newTree = updateTree(repo, currentTree, path, blobOid);
  const commitSha = makeCommit(repo, newTree, tip === undefined ? [] : [tip], message);
  repo.refs.set(refName(branch), commitSha);
  return { ok: true, commitSha, contentSha: blobOid, created };
}

/** The contents API's delete: remove `path` from `branch` with a commit. */
export function deleteContents(
  repo: Repo,
  branch: string,
  path: string,
  message: string,
  sha?: string,
): ContentsResult {
  const tip = branchTip(repo, branch);
  if (tip === undefined) return { ok: false, reason: 'not-found' };
  const current = readFileAt(repo, tip, path);
  if (current === null) return { ok: false, reason: 'not-found' };
  if (sha !== undefined && current.oid !== sha) return { ok: false, reason: 'stale' };
  const currentTree = treeAt(repo, tip)!;
  const newTree = updateTree(repo, currentTree, path, null);
  const commitSha = makeCommit(repo, newTree, [tip], message);
  repo.refs.set(refName(branch), commitSha);
  return { ok: true, commitSha, contentSha: current.oid, created: false };
}

/** List a ref's commits, newest first (depth-first from the tip). */
export function listCommits(repo: Repo, ref: string): Array<{ sha: string; message: string }> {
  const tip = resolveRef(repo, ref);
  if (tip === undefined) return [];
  const out: Array<{ sha: string; message: string }> = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    // The stored object bytes end the message with "\n" (git convention);
    // the API presents the message the way GitHub does, without it.
    out.push({ sha: oid, message: commit.message.replace(/\n$/, '') });
    for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i]!);
  }
  return out;
}

// ---------------------------------------------------------------- ancestry, diff, merge

/** Every ancestor of `oid` (including itself), via parent links. */
export function ancestorsOf(repo: Repo, oid: string): Set<string> {
  const out = new Set<string>();
  const stack = [oid];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (out.has(current)) continue;
    out.add(current);
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return out;
}

/** Whether `ancestor` is reachable from `descendant` (or equal to it). */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  if (ancestor === ZERO_OID) return true;
  return ancestorsOf(repo, descendant).has(ancestor);
}

/** The merge base of two commits: the newest common ancestor (linear histories). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const aAncestors = ancestorsOf(repo, a);
  const stack = [b];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (aAncestors.has(current)) return current;
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'commit') continue;
    for (let i = parseCommit(object.data).parents.length - 1; i >= 0; i -= 1) {
      stack.push(parseCommit(object.data).parents[i]!);
    }
  }
  return null;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

/** The files that differ between two trees (null tree = empty). */
export function diffTrees(repo: Repo, baseTree: string | null, headTree: string | null): FileChange[] {
  const base = baseTree === null ? new Map() : flattenTree(repo, baseTree);
  const head = headTree === null ? new Map() : flattenTree(repo, headTree);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h === undefined) out.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
    else if (b === undefined && h !== undefined) out.push({ path, status: 'added', oldOid: null, newOid: h.oid });
    else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
      out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
    }
  }
  return out;
}

/** A crude line diff: lines added and removed between two blobs. */
export function lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldData === null ? [] : oldData.toString('utf8').split('\n');
  const newLines = newData === null ? [] : newData.toString('utf8').split('\n');
  const oldCount = new Map<string, number>();
  for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = oldCount.get(line) ?? 0;
    if (left > 0) oldCount.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCount.values()) deletions += left;
  return { additions, deletions };
}

/** Whether merging `headTip` into `baseTip` would conflict. */
export function mergeConflicts(repo: Repo, headTip: string, baseTip: string): boolean {
  const base = mergeBase(repo, headTip, baseTip);
  if (base === null) return false;
  const baseTree = treeAt(repo, base);
  const headTree = treeAt(repo, headTip);
  const baseTipTree = treeAt(repo, baseTip);
  const headChanges = diffTrees(repo, baseTree ?? null, headTree ?? null);
  const baseChanges = diffTrees(repo, baseTree ?? null, baseTipTree ?? null);
  const baseChanged = new Map(baseChanges.map((change) => [change.path, change.newOid]));
  for (const change of headChanges) {
    if (!baseChanged.has(change.path)) continue;
    if (baseChanged.get(change.path) !== change.newOid) return true;
  }
  return false;
}

/** Squash-merge a pull request onto its base branch. Returns the merge commit or null on conflict. */
export function squashMerge(store: Store, repo: Repo, pull: Pull): string | null {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return null;
  if (mergeConflicts(repo, headTip, baseTip)) return null;
  const headTree = treeAt(repo, headTip)!;
  const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
  const mergeSha = makeCommit(repo, headTree, [baseTip], message);
  repo.refs.set(refName(pull.baseRef), mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_ISO;
  pull.mergeCommitSha = mergeSha;
  void store;
  return mergeSha;
}

// ---------------------------------------------------------------- issues and pulls

export function createIssue(store: Store, repo: Repo, title: string, body: string, labels: string[]): Issue {
  const issue: Issue = {
    id: store.nextIssueId++,
    number: repo.nextIssue++,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    seq: store.nextSeq++,
  };
  repo.issues.push(issue);
  return issue;
}

export function createPull(
  store: Store,
  repo: Repo,
  head: string,
  base: string,
  title: string,
  body: string,
): Pull | { error: 'duplicate' | 'no-head' | 'no-base' } {
  const headSha = branchTip(repo, head);
  if (headSha === undefined) return { error: 'no-head' };
  const baseSha = branchTip(repo, base);
  if (baseSha === undefined) return { error: 'no-base' };
  for (const existing of repo.pulls) {
    if (existing.headRef === head && existing.state === 'open') return { error: 'duplicate' };
  }
  const pull: Pull = {
    id: store.nextPullId++,
    number: repo.nextPull++,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    seq: store.nextSeq++,
  };
  repo.pulls.push(pull);
  return pull;
}

/** The objects a fetch of `wants` must send, given what the client holds. */
/** Generations from the wants to the farthest shallow boundary (0 when a boundary is itself a want). */
function boundaryDistance(repo: Repo, wants: readonly string[], boundaries: readonly string[]): number {
  const targets = new Set(boundaries);
  if (targets.size === 0) return 0;
  const seen = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = wants.map((oid) => ({ oid, depth: 0 }));
  let head = 0;
  let max = 0;
  while (head < queue.length) {
    const { oid, depth } = queue[head++]!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (targets.has(oid) && depth > max) max = depth;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!seen.has(parent)) queue.push({ oid: parent, depth: depth + 1 });
    }
  }
  return max;
}

export function fetchObjects(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth?: number,
  deepenRelative = false,
): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // `deepen N` on its own is an absolute target depth (the suite sends
  // `deepen 2` for a depth-1 clone and expects exactly one more
  // generation). With `deepen-relative` (real git's --deepen), N counts
  // from the client's current boundary: target = N + (1 + the boundary's
  // distance from the wants).
  const effectiveDepth =
    depth === undefined ? undefined : deepenRelative ? depth + 1 + boundaryDistance(repo, wants, shallowBoundaries) : depth;
  // What the client already holds: the closure of its haves, with walks cut
  // at its shallow boundaries (it does not hold those commits' parents).
  const stopAt = new Set(shallowBoundaries);
  const held = haves.length > 0 ? collectReachable(haves, lookup, { stopAt }) : new Set<string>();
  // What the fetch wants: the closure of the wants, cut only by the depth
  // limit. The client's shallow boundaries do NOT cut this walk: a deepen
  // must deliver the parents of a boundary the client already holds.
  const wanted = collectReachable(wants, lookup, { maxDepth: effectiveDepth });
  const send = new Set<string>();
  for (const oid of wanted) if (!held.has(oid)) send.add(oid);
  // Shallow boundaries: included commits whose parents were cut by the depth
  // limit (or by a shallow boundary), i.e. commits in the wanted set whose
  // parents are not all in the wanted set.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (effectiveDepth !== undefined) {
    const wantedCommits = new Set<string>();
    for (const oid of wanted) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'commit') wantedCommits.add(oid);
    }
    for (const oid of wantedCommits) {
      const object = repo.objects.get(oid)!;
      const parents = parseCommit(object.data).parents;
      if (parents.some((parent) => !wantedCommits.has(parent))) shallow.push(oid);
    }
    for (const boundary of shallowBoundaries) {
      if (wantedCommits.has(boundary)) {
        const object = repo.objects.get(boundary);
        if (object !== undefined && object.type === 'commit') {
          const parents = parseCommit(object.data).parents;
          if (parents.every((parent) => wantedCommits.has(parent))) unshallow.push(boundary);
        }
      }
    }
  }
  const objects: GitObject[] = [];
  for (const oid of send) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  return { objects, shallow, unshallow };
}
