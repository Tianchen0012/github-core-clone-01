// gitproto.ts — git smart HTTP: protocol v2 upload-pack (advertisement,
// ls-refs, fetch) and v0 receive-pack (advertisement, push with report-status).
//
// Packfiles are written undeltified (always valid; the suite's client only
// requires that sent deltas resolve, and it sends none). Packfiles are read
// with full OFS_DELTA / REF_DELTA resolution. Ref updates are fast-forward
// only, per ref, with a report-status line each.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  decodePktLines,
  encodePktLine,
  hashObject,
  parseTag,
  pktDelim,
  pktFlush,
  readPack,
  splitAtFlush,
  writePack,
  type GitObject,
} from './git.ts';
import {
  fetchObjects,
  isAncestor,
  refName,
  type Repo,
  type Store,
} from './store.ts';
import { decodeSegment, pathOf, queryOf, readBody, sendBuffer, sendJson } from './util.ts';

const AGENT = 'github-core-clone/1.0.0';
const UPLOAD_AD_CT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD_CT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT_CT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT_CT = 'application/x-git-receive-pack-result';

interface RefLine {
  name: string;
  oid: string;
  peeled?: string;
}

/** All refs of a repo, sorted by name, with peeled tag targets. */
function listRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const line: RefLine = { name, oid };
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const tag = parseTag(object.data);
      const target = repo.objects.get(tag.object);
      if (target !== undefined && target.type === 'commit') line.peeled = tag.object;
    }
    out.push(line);
  }
  return out;
}

/** The default branch tip, or undefined when the repo has no refs. */
function defaultTip(repo: Repo): string | undefined {
  return repo.refs.get(refName(repo.defaultBranch));
}

function v2Advertisement(): Buffer {
  // NOTE: no "# service=..." preamble here. Real git (2.43) reads the first
  // pkt-line as the version line and rejects the advertisement when the
  // service preamble comes first; the suite's parser accepts either.
  const lines = [
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
  ];
  return Buffer.concat([...lines.map((line) => encodePktLine(line)), pktFlush()]);
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-receive-pack'
      ? `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`
      : `multi_ack multi_ack_detailed side-band-64k thin-pack ofs-delta agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const chunks: Buffer[] = [encodePktLine(`# service=${service}\n`), pktFlush()];
  const refs = listRefs(repo);
  const tip = defaultTip(repo);
  if (refs.length === 0) {
    chunks.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headLine = tip !== undefined ? `${tip} HEAD\0${caps}\n` : `${ZERO_OID} HEAD\0${caps}\n`;
    chunks.push(encodePktLine(headLine));
    for (const ref of refs) {
      chunks.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) chunks.push(encodePktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

/** One sideband packet: band byte + payload, framed as a pkt-line. */
function sidebandPacket(band: 1 | 2 | 3, payload: Buffer): Buffer {
  return encodePktLine(Buffer.concat([Buffer.from([band]), payload]));
}

/** Split a pack into sideband band-1 packets (each payload ≤ 65515 bytes). */
function packSideband(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    out.push(sidebandPacket(1, pack.subarray(offset, Math.min(pack.length, offset + CHUNK))));
  }
  return out;
}

/** Resolve an oid to the commit it names (following one annotated tag). */
function resolveToCommit(repo: Repo, oid: string): string | undefined {
  const object = repo.objects.get(oid);
  if (object === undefined) return undefined;
  if (object.type === 'commit') return oid;
  if (object.type === 'tag') {
    const tag = parseTag(object.data);
    const target = repo.objects.get(tag.object);
    if (target !== undefined && target.type === 'commit') return tag.object;
  }
  return undefined;
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(lines: string[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const line of lines) {
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const chunks: Buffer[] = [];
  const tip = defaultTip(repo);
  const refs = listRefs(repo);
  const matches = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  // HEAD is a ref like any other for prefix filtering: it is returned when
  // no prefixes were given, or when one of them matches "HEAD" (a clone
  // asks for "ref-prefix HEAD" explicitly). It is NOT returned for prefixes
  // such as "refs/heads/" alone.
  if (matches('HEAD')) {
    if (tip !== undefined) {
      chunks.push(encodePktLine(`${tip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    } else if (args.unborn) {
      chunks.push(encodePktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  }
  for (const ref of refs) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    chunks.push(encodePktLine(`${line}\n`));
  }
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | undefined;
  deepenRelative: boolean;
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: undefined, deepenRelative: false };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line === 'deepen-relative') args.deepenRelative = true;
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.deepen = n;
    }
  }
  return args;
}

function fetchResponseV2(repo: Repo, args: FetchArgs): Buffer {
  const { objects, shallow, unshallow } = fetchObjects(repo, args.wants, args.haves, args.shallow, args.deepen, args.deepenRelative);
  const chunks: Buffer[] = [];
  // The acknowledgments section is only sent when the client sent haves.
  // Real git errors ("expected 'packfile', received 'acknowledgments'") when
  // it arrives on a have-less fetch; the suite's section parser accepts it
  // either way.
  if (args.haves.length > 0) {
    chunks.push(encodePktLine('acknowledgments\n'));
    for (const have of args.haves) chunks.push(encodePktLine(`ACK ${have}\n`));
    chunks.push(encodePktLine('ready\n'));
    chunks.push(pktDelim());
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    chunks.push(encodePktLine('shallow-info\n'));
    for (const oid of shallow) chunks.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) chunks.push(encodePktLine(`unshallow ${oid}\n`));
    chunks.push(pktDelim());
  }
  if (objects.length > 0) {
    const sorted = [...objects].sort((a, b) => {
      const ao = hashObject(a.type, a.data);
      const bo = hashObject(b.type, b.data);
      return ao < bo ? -1 : ao > bo ? 1 : 0;
    });
    chunks.push(encodePktLine('packfile\n'));
    for (const packet of packSideband(writePack(sorted))) chunks.push(packet);
  }
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

function fetchResponseV0(repo: Repo, args: FetchArgs): Buffer {
  const { objects, shallow, unshallow } = fetchObjects(repo, args.wants, args.haves, args.shallow, args.deepen, args.deepenRelative);
  const chunks: Buffer[] = [];
  if (args.haves.length > 0) {
    for (const have of args.haves) chunks.push(encodePktLine(`ACK ${have}\n`));
    chunks.push(encodePktLine('ready\n'));
  } else {
    chunks.push(encodePktLine('NAK\n'));
  }
  for (const oid of shallow) chunks.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) chunks.push(encodePktLine(`unshallow ${oid}\n`));
  if (objects.length > 0) {
    const sorted = [...objects].sort((a, b) => {
      const ao = hashObject(a.type, a.data);
      const bo = hashObject(b.type, b.data);
      return ao < bo ? -1 : ao > bo ? 1 : 0;
    });
    for (const packet of packSideband(writePack(sorted))) chunks.push(packet);
  }
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parsePushCommands(lines: string[]): PushCommand[] | null {
  const commands: PushCommand[] = [];
  for (const raw of lines) {
    const line = raw.split('\0')[0]!;
    const parts = line.trim().split(' ');
    if (parts.length !== 3) return null;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!/^[0-9a-f]{40}$/.test(oldOid) || !/^[0-9a-f]{40}$/.test(newOid) || !ref.startsWith('refs/')) return null;
    commands.push({ oldOid, newOid, ref });
  }
  return commands;
}

function pushReport(lines: string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const line of lines) chunks.push(sidebandPacket(1, encodePktLine(line)));
  // The report reader on the demultiplexed stream ends on a flush *inside*
  // band 1; without it real git reports "the remote end hung up
  // unexpectedly" after reading the lines. The raw flush then ends the
  // outer stream. The suite's parser filters the inner flush out.
  chunks.push(sidebandPacket(1, pktFlush()));
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

async function handleReceivePack(repo: Repo, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  let lines: string[];
  let packBytes: Buffer;
  try {
    const { lines: packets, rest } = splitAtFlush(body);
    lines = packets.filter((packet) => packet.kind === 'data').map((packet) => (packet as { payload: Buffer }).payload.toString('utf8'));
    packBytes = rest;
  } catch {
    sendBuffer(res, 400, Buffer.from('malformed pkt-line\n', 'utf8'), 'text/plain');
    return;
  }
  const commands = parsePushCommands(lines);
  if (commands === null) {
    sendBuffer(res, 400, Buffer.from('malformed push commands\n', 'utf8'), 'text/plain');
    return;
  }
  // Unpack first: every object lands in the store before any ref moves.
  let unpacked = new Map<string, GitObject>();
  if (packBytes.length > 0) {
    try {
      unpacked = readPack(packBytes);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const report = [`unpack ${message}\n`, ...commands.map((command) => `ng ${command.ref} unpack failed\n`)];
      sendBuffer(res, 200, pushReport(report), RECEIVE_RESULT_CT);
      return;
    }
    for (const [oid, object] of unpacked) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
  }
  const report: string[] = ['unpack ok\n'];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    let problem: string | null = null;
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) problem = 'remote ref does not exist';
      else if (command.oldOid !== ZERO_OID && command.oldOid !== current) problem = 'old value mismatch';
    } else {
      if (repo.objects.get(command.newOid) === undefined) {
        problem = 'object not found';
      } else if (command.oldOid === ZERO_OID) {
        if (current !== undefined) problem = 'remote ref already exists';
      } else {
        if (current === undefined) problem = 'remote ref does not exist';
        else if (command.oldOid !== current) problem = 'old value mismatch';
        else {
          const newCommit = resolveToCommit(repo, command.newOid);
          const oldCommit = resolveToCommit(repo, command.oldOid);
          if (newCommit === undefined || oldCommit === undefined) problem = 'object not found';
          else if (!isAncestor(repo, oldCommit, newCommit)) problem = 'non-fast-forward';
        }
      }
    }
    if (problem !== null) {
      report.push(`ng ${command.ref} ${problem}\n`);
      continue;
    }
    if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
    else repo.refs.set(command.ref, command.newOid);
    report.push(`ok ${command.ref}\n`);
  }
  sendBuffer(res, 200, pushReport(report), RECEIVE_RESULT_CT);
}

async function handleUploadPack(repo: Repo, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    sendBuffer(res, 400, Buffer.from('malformed pkt-line\n', 'utf8'), 'text/plain');
    return;
  }
  const dataLines = packets.filter((packet) => packet.kind === 'data').map((packet) => (packet as { payload: Buffer }).payload.toString('utf8').replace(/\n$/, ''));
  const first = dataLines[0] ?? '';
  if (first === 'command=ls-refs') {
    sendBuffer(res, 200, lsRefsResponse(repo, parseLsRefsArgs(dataLines.slice(1))), UPLOAD_RESULT_CT);
    return;
  }
  if (first === 'command=fetch') {
    sendBuffer(res, 200, fetchResponseV2(repo, parseFetchArgs(dataLines.slice(1))), UPLOAD_RESULT_CT);
    return;
  }
  if (first.startsWith('want ')) {
    // v0 fetch.
    const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: undefined, deepenRelative: false };
    let seenDone = false;
    for (const line of dataLines) {
      if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0]!);
      else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
      else if (line === 'deepen-relative') args.deepenRelative = true;
      else if (line.startsWith('deepen ')) {
        const n = parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(n) && n > 0) args.deepen = n;
      } else if (line === 'done') seenDone = true;
    }
    void seenDone;
    sendBuffer(res, 200, fetchResponseV0(repo, args), UPLOAD_RESULT_CT);
    return;
  }
  sendBuffer(res, 400, Buffer.from('unknown upload-pack command\n', 'utf8'), 'text/plain');
}

/** The git smart-HTTP handler. Returns true when the path was a .git route. */
export async function handleGit(store: Store, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = pathOf(req);
  const match = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
  if (match === null) return false;
  const owner = decodeSegment(match[1]!);
  const repoName = decodeSegment(match[2]!);
  const action = match[3]!;
  const method = req.method ?? 'GET';
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  if (method === 'GET' && action === 'info/refs') {
    const service = queryOf(req).get('service');
    if (service === 'git-upload-pack') {
      if ((req.headers['git-protocol'] ?? '') === 'version=2') {
        sendBuffer(res, 200, v2Advertisement(), UPLOAD_AD_CT);
      } else {
        sendBuffer(res, 200, v0Advertisement(repo, 'git-upload-pack'), UPLOAD_AD_CT);
      }
      return true;
    }
    if (service === 'git-receive-pack') {
      sendBuffer(res, 200, v0Advertisement(repo, 'git-receive-pack'), RECEIVE_AD_CT);
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  if (method === 'POST' && action === 'git-upload-pack') {
    await handleUploadPack(repo, req, res);
    return true;
  }
  if (method === 'POST' && action === 'git-receive-pack') {
    await handleReceivePack(repo, req, res);
    return true;
  }

  sendJson(res, 404, { message: 'Not Found' });
  return true;
}
