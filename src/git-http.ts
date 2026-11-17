// The git smart-HTTP surface: ref advertisements (v0 and v2), ls-refs, upload-pack (fetch,
// v0 and v2) and receive-pack (push). Written from the wire contract the kit's client
// implements: the v0 advertisement's first line carries the capabilities after a NUL, the v2
// advertisement is `version 2` plus capability lines, ls-refs answers `<oid> <name>` with
// `symref-target:`/`peeled:` attributes, a v2 fetch answers in sections (acknowledgments,
// shallow-info, packfile) with the pack on sideband band 1, and a push answers report-status
// (also on band 1) with `unpack ok` plus one `ok`/`ng` line per ref.

import {
  collectDepthLimited,
  collectReachable,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
  type ObjectLookup,
} from './git-core.ts';
import { peelToCommit, DEFAULT_BRANCH, type Repo } from './store.ts';

/** The agent string this forge advertises. */
export const FORGE_AGENT = 'forge/1.0';

/** The largest sideband payload per pkt-line (65520 minus the length header and the band byte). */
const SIDEBAND_CHUNK = 65515;

const DEFAULT_BRANCH_REF = `refs/heads/${DEFAULT_BRANCH}`;

/** A ref, sorted by name, as the advertisements list them. */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const entries = [...repo.refs.entries()].map(([name, oid]) => ({ name, oid }));
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries;
}

/** The v0 upload-pack capabilities (the first line's tokens, after the NUL). */
function uploadPackCaps(repo: Repo): string {
  const tokens = ['side-band-64k', 'ofs-delta', 'shallow', `agent=${FORGE_AGENT}`];
  if (repo.refs.has(DEFAULT_BRANCH_REF)) tokens.push(`symref=HEAD:${DEFAULT_BRANCH_REF}`);
  return tokens.join(' ');
}

/** The v0 receive-pack capabilities (the first line's tokens, after the NUL). */
function receivePackCaps(repo: Repo): string {
  const tokens = ['report-status', 'report-status-v2', 'side-band-64k', 'delete-refs', 'ofs-delta', `agent=${FORGE_AGENT}`];
  if (repo.refs.has(DEFAULT_BRANCH_REF)) tokens.push(`symref=HEAD:${DEFAULT_BRANCH_REF}`);
  return tokens.join(' ');
}

/**
 * A v0 ref advertisement: the service preamble, then the refs. The first line carries the
 * capabilities after a NUL; it is the HEAD line when the default branch exists, the first ref
 * otherwise, or the `capabilities^{}` pseudo-ref for an empty repository. Peeled tags follow
 * their tag line as `<peeled> <ref>^{}`.
 */
export function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? uploadPackCaps(repo) : receivePackCaps(repo);
  const items: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(DEFAULT_BRANCH_REF);
  if (refs.length === 0) {
    items.push(`${ZERO_OID} capabilities^{}\u0000${caps}\n`);
  } else {
    if (headOid !== undefined) items.push(`${headOid} HEAD\u0000${caps}\n`);
    else items.push(`${refs[0]!.oid} ${refs[0]!.name}\u0000${caps}\n`);
    for (const ref of refs) {
      items.push(`${ref.oid} ${ref.name}\n`);
      if (ref.name.startsWith('refs/tags/')) {
        const peeled = peelToCommit(repo, ref.oid);
        if (peeled !== ref.oid) items.push(`${peeled} ${ref.name}^{}\n`);
      }
    }
  }
  items.push('flush');
  return encodePktLines(items);
}

/** A v2 capability advertisement for upload-pack (the service preamble, then `version 2`). */
export function advertisementV2(): Buffer {
  return encodePktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    `agent=${FORGE_AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'server-option\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

// ---------------------------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------------------------

export interface LsRefsArgs {
  readonly peel: boolean;
  readonly symrefs: boolean;
  readonly unborn: boolean;
  readonly prefixes: string[];
}

/** Parse a v2 ls-refs request body into its arguments. */
export function parseLsRefsArgs(body: Buffer): LsRefsArgs {
  const { packets } = decodePktLines(body);
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!pastDelim) continue;
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  return { peel, symrefs, unborn, prefixes };
}

/**
 * The ls-refs answer: `<oid> <name>` plus `symref-target:` for HEAD and `peeled:` for tags.
 * With a ref-prefix the answer holds only the refs that match it (HEAD never matches a
 * `refs/...` prefix, so it is left out). An empty repository answers the unborn HEAD line.
 */
export function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: Array<string | 'flush'> = [];
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const headOid = repo.refs.get(DEFAULT_BRANCH_REF);
  if (args.prefixes.length === 0) {
    if (headOid !== undefined) {
      lines.push(`${headOid} HEAD${args.symrefs ? ` symref-target:${DEFAULT_BRANCH_REF}` : ''}\n`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD${args.symrefs ? ` symref-target:${DEFAULT_BRANCH_REF}` : ''}\n`);
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel && ref.name.startsWith('refs/tags/')) {
      const peeled = peelToCommit(repo, ref.oid);
      if (peeled !== ref.oid) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

// ---------------------------------------------------------------------------------------------
// fetch (upload-pack)
// ---------------------------------------------------------------------------------------------

export interface FetchArgs {
  readonly wants: string[];
  readonly haves: string[];
  /** The client's current shallow boundary (the `shallow` lines it sent). */
  readonly shallow: string[];
  /** The requested depth (`deepen N`), or null for a full fetch. */
  readonly depth: number | null;
}

/** Parse a v2 fetch request body. */
export function parseFetchV2Args(body: Buffer): FetchArgs {
  const { packets } = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !pastDelim) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5));
    else if (line.startsWith('have ')) haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) {
      const parsed = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(parsed) && parsed > 0) depth = parsed;
    }
  }
  return { wants, haves, shallow, depth };
}

/** Parse a v0 fetch request body (two sections: wants, then haves). */
export function parseFetchV0Args(body: Buffer): FetchArgs {
  const { packets } = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      // The first want carries the requested features after the id.
      const rest = line.slice(5);
      const space = rest.indexOf(' ');
      wants.push(space < 0 ? rest : rest.slice(0, space));
    } else if (line.startsWith('have ')) haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) {
      const parsed = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(parsed) && parsed > 0) depth = parsed;
    }
  }
  return { wants, haves, shallow, depth };
}

/** The objects a fetch must send, and the shallow-info it must report. */
export interface FetchPlan {
  /** The objects to send, in a deterministic order. */
  readonly objects: GitObject[];
  /** The new shallow boundary (commits at generation depth-1). */
  readonly boundary: string[];
  /** The old boundary commits that are now interior. */
  readonly unshallow: string[];
}

/** Plan a fetch: the walk's objects minus the have-closure (which stops at the shallow boundary). */
export function planFetch(repo: Repo, args: FetchArgs): FetchPlan {
  const lookup: ObjectLookup = (oid) => repo.objects.get(oid);
  const stopAt = new Set(args.shallow);
  const haveReachable =
    args.haves.length === 0
      ? new Set<string>()
      : collectReachable(args.haves, lookup, { allowMissing: true, stopAt });
  let walked: Set<string>;
  let boundary: string[] = [];
  let unshallow: string[] = [];
  if (args.depth !== null) {
    const walk = collectDepthLimited(args.wants, lookup, args.depth, stopAt);
    walked = walk.objects;
    boundary = walk.boundary;
    unshallow = walk.unshallow;
  } else {
    walked = collectReachable(args.wants, lookup, { allowMissing: true });
    // A full fetch un-shallows the old boundary commits it now covers.
    for (const oid of stopAt) if (walked.has(oid)) unshallow.push(oid);
  }
  const oids = [...walked].filter((oid) => !haveReachable.has(oid)).sort();
  const objects: GitObject[] = [];
  for (const oid of oids) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push({ type: object.type, data: object.data });
  }
  return { objects, boundary, unshallow };
}

/** Split bytes into sideband packets on `band` (each at most the pkt-line maximum). */
function sidebandPackets(band: 1 | 2 | 3, data: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += SIDEBAND_CHUNK) {
    const chunk = data.subarray(offset, offset + SIDEBAND_CHUNK);
    packets.push(encodePktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return packets;
}

/** The acknowledgment line for a fetch: ACK the last known have (plus `ready`), else NAK. */
function acknowledgment(repo: Repo, args: FetchArgs): string[] {
  if (args.haves.length === 0) return ['NAK\n'];
  const known = args.haves.filter((have) => repo.objects.has(have));
  if (known.length === 0) return ['NAK\n'];
  return [`ACK ${known[known.length - 1]}\n`, 'ready\n'];
}

/** A v2 fetch answer, in sections: acknowledgments, shallow-info, packfile. */
export function fetchV2Response(repo: Repo, args: FetchArgs, plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  const ackLines = acknowledgment(repo, args);
  parts.push(encodePktLines(['acknowledgments\n', ...ackLines, 'flush']));
  if (plan.boundary.length > 0 || plan.unshallow.length > 0) {
    const lines: Array<string | 'flush'> = ['shallow-info\n'];
    for (const oid of plan.boundary) lines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('flush');
    parts.push(encodePktLines(lines));
  }
  if (plan.objects.length > 0) {
    const pack = writePack(plan.objects);
    parts.push(encodePktLines(['packfile\n']));
    for (const packet of sidebandPackets(1, pack)) parts.push(packet);
    parts.push(encodePktLines(['flush']));
  }
  return Buffer.concat(parts);
}

/** A v0 fetch answer: the acknowledgment, shallow-info lines, then the pack on sideband band 1. */
export function fetchV0Response(repo: Repo, args: FetchArgs, plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  const lines: string[] = [...acknowledgment(repo, args)];
  for (const oid of plan.boundary) lines.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
  parts.push(encodePktLines(lines));
  if (plan.objects.length > 0) {
    const pack = writePack(plan.objects);
    for (const packet of sidebandPackets(1, pack)) parts.push(packet);
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// push (receive-pack)
// ---------------------------------------------------------------------------------------------

export interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

export interface PushReportLine {
  readonly ref: string;
  readonly ok: boolean;
  readonly reason: string;
}

export interface PushResult {
  /** Whether the pack unpacked (its objects are in the store). */
  readonly unpackOk: boolean;
  readonly unpackDetail: string;
  readonly refs: PushReportLine[];
}

/**
 * Parse a receive-pack body: the command list (pkt-lines up to the first flush, the first line
 * carrying the requested capabilities after a NUL) and the pack that follows it (raw bytes).
 */
export function parsePushBody(body: Buffer): { commands: PushCommand[]; pack: Buffer | null } {
  const { packets, trailingOffset } = decodePktLines(body);
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\u0000');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length !== 3) throw new Error(`push command line is malformed: ${JSON.stringify(line.slice(0, 60))}`);
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid)) {
      throw new Error(`push command names a bad object id: ${JSON.stringify(line.slice(0, 60))}`);
    }
    commands.push({ oldOid, newOid, ref });
  }
  const pack = trailingOffset >= 0 ? body.subarray(trailingOffset) : null;
  return { commands, pack: pack !== null && pack.length > 0 ? pack : null };
}

/** Whether a ref may be created, updated or deleted by a push (only heads and tags). */
function pushableRef(ref: string): boolean {
  return ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/');
}

/**
 * Apply a push: unpack the pack into the store, then apply each command in order. A command is
 * refused (reported `ng`) when the ref is not pushable, the old id does not match the current
 * tip, the new id is not in the store, or the update is not a fast-forward; a refused command
 * changes nothing, and the other commands still apply. The pack is unpacked even when every
 * command is refused, so the report always carries `unpack ok`.
 */
export function applyPush(repo: Repo, commands: readonly PushCommand[], pack: Buffer | null): PushResult {
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack !== null) {
    try {
      const read = readPack(pack, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, { type: object.type, data: object.data });
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = `unpacker error: ${(err as Error).message}`;
    }
  }
  const refs: PushReportLine[] = [];
  for (const command of commands) {
    if (!unpackOk) {
      // A failed unpack refuses every command, deletes included: nothing is applied.
      refs.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    if (!pushableRef(command.ref)) {
      refs.push({ ref: command.ref, ok: false, reason: 'refusing to update a non-pushable ref' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // A delete.
      if (current === undefined) {
        refs.push({ ref: command.ref, ok: false, reason: 'the ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        refs.push({ ref: command.ref, ok: false, reason: 'the old id does not match the current ref' });
      } else {
        repo.refs.delete(command.ref);
        refs.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    const newObject = repo.objects.get(command.newOid);
    if (newObject === undefined) {
      refs.push({ ref: command.ref, ok: false, reason: 'the new object is not in the store' });
      continue;
    }
    if (current === undefined) {
      // A create: the old id must be zero.
      if (command.oldOid !== ZERO_OID) {
        refs.push({ ref: command.ref, ok: false, reason: 'the old id does not match the current ref' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      refs.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (command.oldOid !== current) {
      refs.push({ ref: command.ref, ok: false, reason: 'the old id does not match the current ref' });
      continue;
    }
    if (command.newOid === current) {
      refs.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    // A fast-forward only: the current tip must be an ancestor of the new tip.
    if (newObject.type === 'commit') {
      if (!isAncestor(current, command.newOid, (oid) => repo.objects.get(oid))) {
        refs.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    } else if (newObject.type === 'tag') {
      // A tag update fast-forwards only when its target reaches the current tip.
      const target = parseTag(newObject.data).object;
      if (!isAncestor(current, target, (oid) => repo.objects.get(oid))) {
        refs.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    } else {
      refs.push({ ref: command.ref, ok: false, reason: 'the new object is not a commit or tag' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    refs.push({ ref: command.ref, ok: true, reason: '' });
  }
  return { unpackOk, unpackDetail, refs };
}

/** The report-status answer: `unpack ok` plus one `ok`/`ng` line per ref, on sideband band 1. */
export function pushReportResponse(result: PushResult): Buffer {
  const lines = [`unpack ${result.unpackOk ? 'ok' : result.unpackDetail}\n`];
  for (const ref of result.refs) {
    lines.push(ref.ok ? `ok ${ref.ref}\n` : `ng ${ref.ref} ${ref.reason}\n`);
  }
  const report = encodePktLines(lines);
  const parts = sidebandPackets(1, report);
  parts.push(encodePktLines(['flush']));
  return Buffer.concat(parts);
}

/** The object ids a pack claims, for validation (used by the REST surface, not the wire). */
export function packObjectIds(pack: Buffer): string[] {
  const read = readPack(pack);
  return [...read.objects.keys()];
}

export { hashObject, parseCommit, parseTag, parseTree };
