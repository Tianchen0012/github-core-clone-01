// git.ts — the git object model, packfiles and pkt-lines, stdlib only.
//
// Everything the forge stores and serves over smart HTTP goes through here:
// SHA-1 object ids, tree/commit/tag encoding, undeltified packfile writing and
// full packfile reading (OFS_DELTA / REF_DELTA resolution), pkt-line framing,
// and reachability walks with depth limits and shallow boundaries.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

/** SHA-1 hex of bytes. */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** A git object's id: SHA-1 over "<type> <size>\0" + data. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function makeObject(type: GitObjectType, data: Buffer): { oid: string; object: GitObject } {
  return { oid: hashObject(type, data), object: { type, data } };
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string; // '100644' for files, '40000' for directories
  name: string;
  oid: string;
}

/** Git's tree sort: entries ordered by name bytes, directories as if ending in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

function compareBytes(a: string, b: string): number {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return Buffer.compare(ba, bb);
}

/** Encode tree entries (sorted per git's rule) into tree object bytes. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((x, y) => compareBytes(treeSortKey(x), treeSortKey(y)));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse tree object bytes into entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------- commits and tags

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string; // "Name <email> <ts> +0000"
  committer: string;
  message: string;
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  return info;
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function buildTag(info: TagInfo): Buffer {
  return Buffer.from(
    `object ${info.object}\ntype ${info.type}\ntag ${info.tag}\ntagger ${info.tagger}\n\n${info.message}`,
    'utf8',
  );
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  const info: TagInfo = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) info.tag = line.slice(4);
    else if (line.startsWith('tagger ')) info.tagger = line.slice(7);
  }
  return info;
}

// ---------------------------------------------------------------- pkt-lines

export const PKT_LINE_MAX = 65520;

/** One pkt-line framing `data` (data must be < 65516 bytes). */
export function encodePktLine(data: Buffer | string): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const size = payload.length + 4;
  const header = Buffer.from(size.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type PktLine = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' };

/**
 * Decode a whole buffer of pkt-lines. Throws on a malformed length prefix.
 * A trailing partial line is ignored (the caller reads a complete body).
 */
export function decodePktLines(buf: Buffer): PktLine[] {
  const out: PktLine[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const sizeText = buf.subarray(offset, offset + 4).toString('ascii');
    const size = parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size < 0 || size > PKT_LINE_MAX) {
      throw new Error(`malformed pkt-line length ${JSON.stringify(sizeText)}`);
    }
    if (size === 0) {
      out.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (size === 1) {
      out.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (offset + size > buf.length) break; // incomplete tail
    out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + size) });
    offset += size;
  }
  return out;
}

/** Split a buffer at the first flush pkt-line: [lines before flush, bytes after it]. */
export function splitAtFlush(buf: Buffer): { lines: PktLine[]; rest: Buffer } {
  let offset = 0;
  const lines: PktLine[] = [];
  while (offset + 4 <= buf.length) {
    const sizeText = buf.subarray(offset, offset + 4).toString('ascii');
    const size = parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size < 0 || size > PKT_LINE_MAX) {
      throw new Error(`malformed pkt-line length ${JSON.stringify(sizeText)}`);
    }
    if (size === 0) return { lines, rest: buf.subarray(offset + 4) };
    if (size === 1) {
      lines.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (offset + size > buf.length) break;
    lines.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + size) });
    offset += size;
  }
  return { lines, rest: buf.subarray(offset) };
}

// ---------------------------------------------------------------- packfiles

const PACK_TYPE_BY_CODE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_CODE_BY_TYPE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Write one object's type/size varint header (git's pack format). */
function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = PACK_CODE_BY_TYPE[type];
  const out: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  size >>>= 4;
  if (size > 0) first |= 0x80;
  out.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>>= 7;
    if (size > 0) b |= 0x80;
    out.push(b);
  }
  return Buffer.from(out);
}

/** Write an undeltified packfile (version 2) for the given objects, with a valid trailer SHA-1. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Verify a packfile's trailer checksum. */
export function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 32) return false;
  const expected = pack.subarray(pack.length - 20).toString('hex');
  const actual = sha1Hex(pack.subarray(0, pack.length - 20));
  return actual === expected;
}

/** Apply a git delta to `base`, returning the reconstructed object bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[pos++];
      value |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta source size mismatch');
  const chunks: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[pos++];
      if (op & 0x02) offset |= delta[pos++] << 8;
      if (op & 0x04) offset |= delta[pos++] << 16;
      if (op & 0x08) offset |= delta[pos++] << 24;
      if (op & 0x10) size = delta[pos++];
      if (op & 0x20) size |= delta[pos++] << 8;
      if (op & 0x40) size |= delta[pos++] << 16;
      if (size === 0) size = 0x10000;
      chunks.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      chunks.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta op 0');
    }
  }
  const out = Buffer.concat(chunks);
  if (out.length !== targetSize || produced !== targetSize) throw new Error('delta target size mismatch');
  return out;
}

/**
 * Parse a whole packfile into objects keyed by oid, resolving OFS_DELTA and
 * REF_DELTA entries (including delta chains). Throws on corrupt input.
 */
export function readPack(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  interface PackEntry {
    type: GitObjectType | 'ofs-delta' | 'ref-delta';
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    offset: number;
  }
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, number>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = pack[offset++];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      byte = pack[offset++];
      let off = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset++];
        off = ((off + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = start - off;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    // Bounded inflate: inflateSync ignores trailing bytes, so the predicate
    // "this prefix inflates cleanly" is monotonic in the prefix length and a
    // binary search finds the exact end of the zlib stream. The search is
    // bounded by the declared size: a deflate stream is never much larger
    // than its output (stored blocks add ~5 bytes per 64 KiB plus the 6-byte
    // zlib wrapper), so the bound is airtight and the search is short.
    const { data, consumed } = inflateBounded(pack, offset, size);
    offset += consumed;
    const type = PACK_TYPE_BY_CODE[typeCode];
    if (type === undefined && typeCode !== 6 && typeCode !== 7) throw new Error(`unknown pack type ${typeCode}`);
    if (data.length !== size) throw new Error(`pack entry size mismatch: declared ${size}, inflated ${data.length}`);
    entries.push({
      type: typeCode === 6 ? 'ofs-delta' : typeCode === 7 ? 'ref-delta' : (type as GitObjectType),
      data,
      baseOffset,
      baseOid,
      offset: start,
    });
    byOffset.set(start, entries.length - 1);
  }

  const resolved = new Map<number, GitObject>();
  const resolving = new Set<number>();
  const resolve = (index: number): GitObject => {
    const cached = resolved.get(index);
    if (cached !== undefined) return cached;
    if (resolving.has(index)) throw new Error('delta cycle in pack');
    resolving.add(index);
    const entry = entries[index]!;
    let result: GitObject;
    if (entry.type === 'ofs-delta') {
      const baseIndex = byOffset.get(entry.baseOffset!);
      if (baseIndex === undefined) throw new Error('ofs-delta base outside pack');
      const base = resolve(baseIndex);
      result = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.type === 'ref-delta') {
      // The base must be an earlier entry in this pack (clients send self-contained packs).
      const baseIndex = entries.findIndex((candidate) => candidate.type !== 'ofs-delta' && candidate.type !== 'ref-delta' && hashObject(candidate.type as GitObjectType, candidate.data) === entry.baseOid);
      if (baseIndex < 0) throw new Error('ref-delta base not in pack');
      const base = resolve(baseIndex);
      result = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      result = { type: entry.type as GitObjectType, data: entry.data };
    }
    resolving.delete(index);
    resolved.set(index, result);
    return result;
  };

  const out = new Map<string, GitObject>();
  for (let i = 0; i < entries.length; i += 1) {
    const object = resolve(i);
    out.set(hashObject(object.type, object.data), object);
  }
  return out;
}

/**
 * Inflate a zlib stream starting at `offset` in `buf`, returning the inflated
 * data and how many input bytes the stream consumed. inflateSync ignores
 * trailing bytes, so "this prefix inflates cleanly" is monotonic in the
 * prefix length and a binary search finds the stream's exact end. The search
 * is bounded by `declaredSize`: a deflate stream is never much larger than
 * its output, so the bound is airtight and the search stays short.
 */
function inflateBounded(buf: Buffer, offset: number, declaredSize: number): { data: Buffer; consumed: number } {
  const remaining = buf.length - offset;
  // Deflate overhead over the output: stored blocks add 5 bytes per 64 KiB,
  // plus the 2-byte zlib header and 4-byte adler32 trailer; 64 bytes of slack
  // plus 0.1% covers every case with room to spare.
  const bound = Math.min(remaining, declaredSize + 64 + Math.floor(declaredSize / 1000) + 16);
  let low = 1;
  let high = Math.max(1, bound);
  let best: Buffer | null = null;
  let bestLen = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    try {
      const data = inflateSync(buf.subarray(offset, offset + mid));
      best = data;
      bestLen = mid;
      high = mid - 1;
    } catch {
      low = mid + 1;
    }
  }
  if (best === null) {
    // The stream may be larger than the bound (pathological input): fall back
    // to searching the whole remainder.
    low = bound + 1;
    high = remaining;
    while (low <= high) {
      const mid = (low + high) >> 1;
      try {
        const data = inflateSync(buf.subarray(offset, offset + mid));
        best = data;
        bestLen = mid;
        high = mid - 1;
      } catch {
        low = mid + 1;
      }
    }
  }
  if (best === null) throw new Error('corrupt zlib stream in pack');
  return { data: best, consumed: bestLen };
}

// ---------------------------------------------------------------- reachability

export interface ReachOptions {
  /** Commit-parent depth limit: 1 = the roots only, 2 = roots + parents, ... */
  maxDepth?: number;
  /** Commits whose parents are not traversed (shallow boundaries); the commit itself is included. */
  stopAt?: ReadonlySet<string>;
}

/**
 * The closure of `roots`: every object reachable from them (commits, tags,
 * trees, blobs). Throws when a referenced object is missing from `lookup`.
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
  options: ReachOptions = {},
): Set<string> {
  const out = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const root of roots) queue.push({ oid: root, depth: 0 });
  const seenCommits = new Set<string>();
  const walkTree = (treeOid: string): void => {
    if (out.has(treeOid)) return;
    const tree = lookup(treeOid);
    if (tree === undefined || tree.type !== 'tree') throw new Error(`missing-object ${treeOid}`);
    out.add(treeOid);
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '40000') {
        walkTree(entry.oid);
      } else {
        if (!out.has(entry.oid)) {
          const blob = lookup(entry.oid);
          if (blob === undefined) throw new Error(`missing-object ${entry.oid}`);
          out.add(entry.oid);
        }
      }
    }
  };
  while (queue.length > 0) {
    const { oid, depth } = queue.shift()!;
    if (out.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) throw new Error(`missing-object ${oid}`);
    if (object.type === 'commit') {
      if (seenCommits.has(oid)) continue;
      seenCommits.add(oid);
      out.add(oid);
      const commit = parseCommit(object.data);
      walkTree(commit.tree);
      const canDescend = options.maxDepth === undefined || depth + 1 < options.maxDepth;
      if (canDescend && !(options.stopAt?.has(oid) ?? false)) {
        for (const parent of commit.parents) queue.push({ oid: parent, depth: depth + 1 });
      }
    } else if (object.type === 'tag') {
      out.add(oid);
      const tag = parseTag(object.data);
      queue.push({ oid: tag.object, depth });
    } else if (object.type === 'tree') {
      walkTree(oid);
    } else {
      out.add(oid);
    }
  }
  return out;
}
