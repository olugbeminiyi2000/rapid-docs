import { Injectable } from "@nestjs/common";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync, Dirent } from "fs";
import { randomUUID } from "crypto";
import { dirname, join } from "path";
import type { File, SourceLocation } from "@babel/types";
import { VISITOR_KEYS } from "@babel/types";
import { AstService } from "./ast.service.js";

// The authoritative source for "does this AST node type ever hold child
// nodes at all" -- VISITOR_KEYS is the exact metadata @babel/traverse itself
// uses to know which fields to recurse into, so a type with zero visitor
// keys can NEVER have a child (NumericLiteral, TSNumberKeyword, etc.), by
// construction rather than by a hand-maintained guess that can silently go
// stale as new node types are added.
//
// "Identifier" is added on top, deliberately, despite Babel listing it as
// technically CAPABLE of children (an optional type annotation, decorators):
// for the overwhelming majority of real code, an Identifier carries neither,
// and behaves exactly like a bare leaf -- and a reused, generic identifier
// name (a parameter called `n`, say) hashing identically everywhere it
// appears is a real, already-proven collision source (Objective 3.30).
const ATOMIC_LEAF_TYPES = new Set<string>([
  ...Object.entries(VISITOR_KEYS)
    .filter(([, keys]) => keys.length === 0)
    .map(([type]) => type),
  "Identifier",
]);

// ATOMIC_LEAF_TYPES is a TYPE-level rule ("can this kind of node ever hold
// children"), but the real question for collision-safety is INSTANCE-level:
// does THIS SPECIFIC node actually hold anything right now. An empty array
// literal `[]` is typed `ArrayExpression` -- which CAN hold elements, so it's
// not in ATOMIC_LEAF_TYPES -- but a specific empty instance carries exactly
// as little information as a bare leaf, and hashes identically to every
// other empty `[]` anywhere in the file. Found for real: a stored record's
// name-derivation anchor set included an unrelated empty `[]` from a
// completely different function elsewhere in the file, stretching the
// bounding box out past anything that could contain it and losing an
// otherwise-derivable name. Checks every one of the node's own potential
// child-holding fields (from VISITOR_KEYS) and confirms none of them
// actually hold anything.
function isLeafNode(node: unknown, type: string): boolean {
  if (ATOMIC_LEAF_TYPES.has(type)) return true;

  const keys = VISITOR_KEYS[type as keyof typeof VISITOR_KEYS] ?? [];
  return keys.every((key) => {
    const value = (node as Record<string, unknown>)[key];
    return value === null || value === undefined || (Array.isArray(value) && value.length === 0);
  });
}

export interface RecordMember {
  type: string;
  hash: string;
  // Whether THIS specific node, at the moment it was documented, actually
  // held any content of its own (see isLeafNode) -- optional because records
  // written before this field existed don't have it; callers fall back to
  // the coarser type-level ATOMIC_LEAF_TYPES check for those.
  isLeaf?: boolean;
}

export interface DocRecord {
  docText: string;
  members: RecordMember[];
}

export interface FileStorage {
  fileId: string;
  records: Record<string, DocRecord>;
}

export interface DriftResult {
  recordId: string;
  status: "unchanged" | "partially_stale" | "fully_stale";
  totalMembers: number;
  changedMembers: { type: string; hash: string }[];
  // A current, human-locatable name for this record, when one can be found
  // -- lets a message point at "findPrimeFibonacciNaive," not a truncated
  // quote of whatever the user happened to type as docText, which tells you
  // nothing about where in the file to actually look. Only possible for a
  // PARTIALLY stale record (something still currently anchors it); a fully
  // stale record has nothing left in the file to derive a name from at all,
  // so this is always null in that case.
  name: string | null;
  // The CURRENT position of every individual anchor (a compound member whose
  // hash still matches) -- deliberately each anchor's OWN span, never merged
  // into one min-to-max bounding box the way name-derivation's search does.
  // A bounding box is fine for THAT purpose (worst case, a coincidental
  // outlier just means no name gets found) but not for painting decorations
  // directly onto the code: merging would risk highlighting everything in
  // between two anchors, including unrelated code an outlier match happens
  // to sit next to. Each anchor's own span is always individually true
  // (its hash really does match), so the worst a stray coincidental match
  // can do here is add one small, separate, isolated decoration -- never
  // swallow unrelated code in between.
  matchingRanges: { start: number; end: number }[];
  // Every current, named container whose content this record's surviving
  // members ALSO equally match, name AND full position -- populated only
  // when matchingRanges came back empty specifically because of a genuine
  // tie (two or more real candidates, not because nothing survived at
  // all). The position is the container's own full span (not just the
  // tied member's tiny span) so a UI can navigate/highlight the whole
  // colliding function, not one fragment of it. Lets a UI explain WHY a
  // location couldn't be found, and jump straight to each real candidate,
  // instead of leaving a user to discover either only by reading raw
  // storage JSON.
  collidesWith: { name: string; start: number; end: number }[];
}

export interface UndocumentedNode {
  type: string;
  start: number;
  end: number;
  loc: SourceLocation | null;
  name: string | null;
  // Lets generateMessages tell "genuinely new, never-documented code" apart
  // from "a node that used to belong to a record and just changed" -- both
  // currently show up here (this computation only checks "is the current
  // hash in the documented set," which a stale node's changed hash also
  // fails), but only the first kind deserves its own info message.
  hash: string;
}

export interface FileCheckReport {
  driftResults: DriftResult[];
  undocumentedNodes: UndocumentedNode[];
}

export interface DocumentedLocation {
  recordId: string;
  type: string;
  start: number;
  end: number;
  loc: SourceLocation | null;
}

export interface Message {
  severity: "info" | "warning" | "error";
  text: string;
  // Which file this message is about -- lets a live-updating UI replace a
  // file's previously-shown messages with its current ones (the correct
  // behavior for a drift detector: a fixed problem should disappear, not
  // persist alongside its own resolution) rather than only ever appending.
  relativePath: string;
  // The specific stored record this message is about, when there is one --
  // null for an undocumented-node "info" message, which has no record at all
  // yet. Lets a UI offer a real delete action scoped to one exact record
  // (a fully-stale one, say) without guessing which record a message text
  // refers to.
  recordId: string | null;
  // Where this message's subject CURRENTLY lives in the file, if anywhere --
  // lets a UI highlight exactly the code a message is about, on demand,
  // instead of guessing or naming it only in prose. Empty for anything with
  // no current code to point at: a fully-stale record (nothing survives) or
  // a message that was never about a specific position at all (a parse
  // failure, a deleted-file notice).
  ranges: { start: number; end: number }[];
  // Every current, named location this message's subject collides with --
  // populated only when ranges came back empty specifically because of a
  // genuine tie (see DriftResult.collidesWith). Lets a UI (e.g. a VSCode
  // DiagnosticRelatedInformation list) point directly at each real
  // candidate, not just say a collision exists.
  collidesWith: { name: string; start: number; end: number }[];
}

export interface ArchivedRecord {
  id: string;
  archivedAt: string;
  originalFileId: string;
  docText: string;
}

// Documentation lives inside the repo itself, mirroring the source tree
// structure exactly (src/math.ts -> .rapid-docs/src/math.ts.json), rather than
// a flat directory of sanitized filenames. Two reasons: mirroring is
// structurally collision-free (a filesystem can't have two files at the same
// path, so this inherits that guarantee for free), and it keeps `git diff`
// legible -- a reviewer sees exactly which source file's documentation
// changed, not an opaque hash.
const STORAGE_DIR = ".rapid-docs";
const ARCHIVE_FILENAME = "_archive.json";

@Injectable()
export class DocumentationService {
  constructor(private readonly astService: AstService) {}

  // relativePath is the stable, cross-machine identity for a file -- the
  // repo-relative path (e.g. "src/math.ts"), always forward-slash, the same
  // string every collaborator's clone agrees on regardless of where they put
  // the repo on disk. repoPath is only ever used to find .rapid-docs/ and to
  // read the real file; it is never part of a file's identity.
  storagePathFor(repoPath: string, relativePath: string): string {
    return join(repoPath, STORAGE_DIR, `${relativePath}.json`);
  }

  loadStorage(repoPath: string, relativePath: string): FileStorage {
    const path = this.storagePathFor(repoPath, relativePath);

    if (!existsSync(path)) {
      return { fileId: relativePath, records: {} };
    }

    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as FileStorage;
  }

  saveStorage(repoPath: string, storage: FileStorage): void {
    const path = this.storagePathFor(repoPath, storage.fileId);
    this.ensureDirFor(path);
    writeFileSync(path, JSON.stringify(storage, null, 2));
  }

  // Every fileId (repo-relative path) that currently has at least one stored
  // record -- read directly from .rapid-docs/, walked recursively since it now
  // mirrors nested source directories rather than being a flat folder.
  listDocumentedFileIds(repoPath: string): string[] {
    const dir = join(repoPath, STORAGE_DIR);

    if (!existsSync(dir)) {
      return [];
    }

    const archivePath = this.archivePathFor(repoPath);
    const fileIds: string[] = [];

    for (const jsonPath of this.walkJsonFiles(dir)) {
      if (jsonPath === archivePath) continue;

      const raw = readFileSync(jsonPath, "utf-8");
      const storage = JSON.parse(raw) as FileStorage;
      fileIds.push(storage.fileId);
    }

    return fileIds;
  }

  // Shared by writeDoc (which then decides whether to reject or create) and
  // findRecordForSelection (which only ever reads) -- the exact same
  // structural computation. Deliberately loose about the highlight's precise
  // character boundaries, since filterByHighlight's contains-based semantics
  // are the whole point: a real human drag that starts a character or two
  // off from an AST node's exact position (its leading whitespace/indent,
  // say) still resolves to the identical recordId either way.
  private computeHighlightMembers(
    ast: File,
    highlightStart: number,
    highlightEnd: number
  ): { members: RecordMember[]; recordId: string } {
    const allNodes = this.astService.walkAllNodes(ast.program.body);
    const matched = this.astService.filterByHighlight(allNodes, highlightStart, highlightEnd);

    const members = matched.map((entry) => ({
      type: entry.type,
      hash: this.astService.hashNode(entry.node),
      isLeaf: isLeafNode(entry.node, entry.type),
    }));

    const sortedMemberHashes = members.map((member) => member.hash).sort();
    const recordId = this.astService.hashNode(sortedMemberHashes);

    return { members, recordId };
  }

  // Lets the renderer refuse to open a file in the editor at all when it
  // can't be parsed -- every doc/drift feature this app has is built on
  // understanding a file's AST, so opening it anyway would just be Monaco
  // showing plain text with every one of those features silently doing
  // nothing. Reuses the exact same parseSource call every other method
  // here does, so "can this be checked/documented" and "can this be
  // opened at all" can never disagree with each other.
  canParseFile(repoPath: string, relativePath: string): boolean {
    const code = readFileSync(join(repoPath, relativePath), "utf-8");
    const { ast } = this.astService.parseSource(code, relativePath);
    return ast !== null;
  }

  writeDoc(
    repoPath: string,
    relativePath: string,
    highlightStart: number,
    highlightEnd: number,
    docText: string
  ): { recordId: string; record: DocRecord } {
    const code = readFileSync(join(repoPath, relativePath), "utf-8");
    const { ast } = this.astService.parseSource(code, relativePath);

    if (!ast) {
      throw new Error("Cannot document: file failed to parse");
    }

    const { members, recordId } = this.computeHighlightMembers(ast, highlightStart, highlightEnd);

    const storage = this.loadStorage(repoPath, relativePath);

    if (storage.records[recordId]) {
      throw new Error(
        `This exact highlight is already documented as record "${recordId}". Use editDocText to change its text instead.`
      );
    }

    const record: DocRecord = { docText, members };
    storage.records[recordId] = record;

    this.saveStorage(repoPath, storage);

    return { recordId, record };
  }

  // Answers "does this exact selection already match a documented record?"
  // without writing anything -- lets the UI decide whether a given
  // selection should offer Edit/Delete (it matches something) or Document
  // (it doesn't), using the SAME structural computation writeDoc itself
  // uses to reject a duplicate. Deliberately NOT a position/offset
  // comparison against a record's reported node boundary (what
  // findDocumentedNodes returns): a real user's drag selection essentially
  // never lands exactly on an AST node's precise character boundary, and
  // position-based matching would reject exactly the selections writeDoc
  // itself would happily recognize as identical.
  findRecordForSelection(
    repoPath: string,
    relativePath: string,
    highlightStart: number,
    highlightEnd: number
  ): { recordId: string; docText: string } | null {
    const code = readFileSync(join(repoPath, relativePath), "utf-8");
    const { ast } = this.astService.parseSource(code, relativePath);

    if (!ast) {
      return null;
    }

    const { recordId } = this.computeHighlightMembers(ast, highlightStart, highlightEnd);
    const storage = this.loadStorage(repoPath, relativePath);
    const record = storage.records[recordId];

    return record ? { recordId, docText: record.docText } : null;
  }

  // The counterpart to findRecordForSelection for the "code drifted, doc
  // didn't" case: no current selection can ever exactly hash-match a
  // partially-stale record again (that's what makes it stale), so
  // findRecordForSelection alone can never offer a way to resolve one.
  // Reuses checkFile's own already-tested drift computation rather than
  // recomputing anything -- a record only qualifies once it's actually
  // PARTIALLY stale (some content survives to anchor a current position at
  // all) and the given selection overlaps where that surviving content
  // currently lives (its matchingRanges). Deliberately excludes fully-stale
  // records: with nothing left to anchor a position to, there's no
  // selection that could meaningfully "overlap" one, and the existing
  // Delete-then-redocument path (Problems tab, error severity) already
  // covers that case. Also, by construction, excludes a record made
  // entirely of leaf members whose drift is only partial (e.g. one of two
  // documented comments changed, the other didn't): matchingRanges only
  // ever reports COMPOUND anchors, so an all-leaf record has none to offer
  // here even when checkFile reports it partially_stale -- a known, narrower
  // gap than the one this method was built to close, not yet solved.
  findStaleRecordForSelection(
    repoPath: string,
    relativePath: string,
    highlightStart: number,
    highlightEnd: number
  ): { recordId: string; docText: string } | null {
    const { driftResults } = this.checkFile(repoPath, relativePath);
    const storage = this.loadStorage(repoPath, relativePath);

    for (const drift of driftResults) {
      if (drift.status !== "partially_stale" || drift.matchingRanges.length === 0) {
        continue;
      }

      const minStart = Math.min(...drift.matchingRanges.map((range) => range.start));
      const maxEnd = Math.max(...drift.matchingRanges.map((range) => range.end));
      const overlaps = highlightStart < maxEnd && minStart < highlightEnd;
      if (!overlaps) {
        continue;
      }

      const record = storage.records[drift.recordId];
      if (record) {
        return { recordId: drift.recordId, docText: record.docText };
      }
    }

    return null;
  }

  // Resolves drift in one atomic step: retires the old, partially-stale
  // record and writes a fresh one for the CURRENT selection under its own
  // current hash. Delete and write happen against the same loaded storage
  // object, saved once -- there's no window where a failure partway through
  // could leave both gone or both present. Guards against the same
  // exact-duplicate case writeDoc itself guards against (the new selection
  // happening to already match some OTHER existing record), but does NOT
  // require the new hash to differ from oldRecordId -- if the current
  // selection happens to hash back to the exact record being replaced (only
  // realistic if nothing about the selected code actually changed), this
  // degrades harmlessly into an ordinary docText update.
  updateDriftedDoc(
    repoPath: string,
    relativePath: string,
    oldRecordId: string,
    highlightStart: number,
    highlightEnd: number,
    docText: string
  ): { recordId: string; record: DocRecord } {
    const code = readFileSync(join(repoPath, relativePath), "utf-8");
    const { ast } = this.astService.parseSource(code, relativePath);

    if (!ast) {
      throw new Error("Cannot update documentation: file failed to parse");
    }

    const storage = this.loadStorage(repoPath, relativePath);

    if (!storage.records[oldRecordId]) {
      throw new Error(`No record "${oldRecordId}" exists for "${relativePath}"`);
    }

    const { members, recordId } = this.computeHighlightMembers(ast, highlightStart, highlightEnd);

    if (storage.records[recordId] && recordId !== oldRecordId) {
      throw new Error(
        `This exact highlight is already documented as record "${recordId}". Use editDocText to change its text instead.`
      );
    }

    delete storage.records[oldRecordId];
    const record: DocRecord = { docText, members };
    storage.records[recordId] = record;

    this.saveStorage(repoPath, storage);

    return { recordId, record };
  }

  deleteRecord(repoPath: string, relativePath: string, recordId: string): void {
    const storage = this.loadStorage(repoPath, relativePath);

    if (!storage.records[recordId]) {
      throw new Error(`No record "${recordId}" exists for "${relativePath}"`);
    }

    delete storage.records[recordId];
    this.saveStorage(repoPath, storage);
  }

  editDocText(repoPath: string, relativePath: string, recordId: string, newText: string): void {
    const storage = this.loadStorage(repoPath, relativePath);
    const record = storage.records[recordId];

    if (!record) {
      throw new Error(`No record "${recordId}" exists for "${relativePath}"`);
    }

    record.docText = newText;
    this.saveStorage(repoPath, storage);
  }

  renameFile(repoPath: string, oldRelativePath: string, newRelativePath: string): void {
    const oldPath = this.storagePathFor(repoPath, oldRelativePath);
    const newPath = this.storagePathFor(repoPath, newRelativePath);

    if (!existsSync(oldPath)) {
      throw new Error(`No storage exists for "${oldRelativePath}" — nothing to rename`);
    }

    if (existsSync(newPath)) {
      throw new Error(`Refusing to rename: storage already exists for "${newRelativePath}"`);
    }

    const storage = this.loadStorage(repoPath, oldRelativePath);
    storage.fileId = newRelativePath;

    this.ensureDirFor(newPath);
    writeFileSync(newPath, JSON.stringify(storage, null, 2));
    unlinkSync(oldPath);
  }

  handleDeletedFile(repoPath: string, relativePath: string): Message[] {
    const path = this.storagePathFor(repoPath, relativePath);

    if (!existsSync(path)) {
      return [];
    }

    const storage = this.loadStorage(repoPath, relativePath);
    const messages: Message[] = [];

    for (const record of Object.values(storage.records)) {
      this.archiveRecord(repoPath, relativePath, record);
      messages.push({
        severity: "warning",
        text: `"${relativePath}" no longer exists. Its documentation is being removed: "${record.docText}"`,
        relativePath,
        recordId: null,
        ranges: [],
        collidesWith: [],
      });
    }

    unlinkSync(path);

    return messages;
  }

  loadArchive(repoPath: string): ArchivedRecord[] {
    const path = this.archivePathFor(repoPath);

    if (!existsSync(path)) {
      return [];
    }

    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as ArchivedRecord[];
  }

  // A convenience wrapper around writeDoc, not a resurrection of renameFile --
  // the archived record's own hashes belong to a file that's gone, so there's
  // nothing to migrate. This computes entirely fresh hashes against the target
  // file's actual current content, just pre-filled with the archived text as a
  // starting draft instead of a blank one.
  attachArchivedRecord(
    repoPath: string,
    archiveId: string,
    relativePath: string,
    highlightStart: number,
    highlightEnd: number
  ): { recordId: string; record: DocRecord } {
    const archive = this.loadArchive(repoPath);
    const index = archive.findIndex((entry) => entry.id === archiveId);

    if (index === -1) {
      throw new Error(`No archived record with id "${archiveId}"`);
    }

    const result = this.writeDoc(repoPath, relativePath, highlightStart, highlightEnd, archive[index].docText);

    archive.splice(index, 1);
    this.saveArchive(repoPath, archive);

    return result;
  }

  discardArchivedRecord(repoPath: string, archiveId: string): void {
    const archive = this.loadArchive(repoPath);
    const index = archive.findIndex((entry) => entry.id === archiveId);

    if (index === -1) {
      throw new Error(`No archived record with id "${archiveId}"`);
    }

    archive.splice(index, 1);
    this.saveArchive(repoPath, archive);
  }

  // Verifies a candidate span by recomputing its WHOLE combined recordId
  // (exactly the same sort-and-hash computation writeDoc uses) and checking
  // that against storage -- rather than checking any single node's hash in
  // isolation. That distinction matters: hashing is deliberately structural
  // and position-invariant, so two functions with the same parameter names
  // (e.g. `add(a, b)` and `sub(a, b)`) produce byte-identical hashes for
  // their `a`/`b` identifiers. A single-hash lookup would wrongly attribute
  // sub's identifiers to add's record; requiring the COMPLETE set of member
  // hashes to match, together, at one location, rules that out entirely.
  findDocumentedNodes(repoPath: string, relativePath: string): DocumentedLocation[] {
    const code = readFileSync(join(repoPath, relativePath), "utf-8");
    const { ast } = this.astService.parseSource(code, relativePath);

    if (!ast) {
      throw new Error("Cannot locate documented nodes: file failed to parse");
    }

    const allNodes = this.astService.walkAllNodes(ast.program.body);
    const storage = this.loadStorage(repoPath, relativePath);

    // Precomputed once: every current node's own hash (shared by the
    // position lookup below and the final verification hash), AND every
    // current position that hash currently lives at -- there can be more
    // than one, for a reused leaf, or genuinely zero, for something that no
    // longer exists at all.
    const hashByKey = new Map<string, string>();
    const positionsByHash = new Map<string, { start: number; end: number }[]>();
    for (const [key, entry] of allNodes) {
      const hash = this.astService.hashNode(entry.node);
      hashByKey.set(key, hash);
      const positions = positionsByHash.get(hash) ?? [];
      positions.push({ start: entry.start, end: entry.end });
      positionsByHash.set(hash, positions);
    }

    // Driven by each STORED record's own hashes, rather than guessing
    // candidate spans up front and checking each one -- the earlier
    // candidate-based approach (try every individual node's own boundary,
    // then every contiguous run of array siblings) kept finding new shapes
    // it couldn't represent: a record spanning the whole file, a record
    // that's a single standalone comment, a record combining a comment with
    // the code it annotates (a comment is a PROPERTY of the node it's
    // attached to, not a sibling array element of it, so no sibling-range
    // candidate could ever span both). This is general on purpose, covering
    // every one of those shapes -- and any future one -- in a single pass:
    // if every one of a record's members still exists SOMEWHERE right now,
    // its bounding box (the min start / max end across all of them) is
    // exactly where that record's content currently lives, if it's still
    // fully intact.
    const found: DocumentedLocation[] = [];

    for (const [recordId, record] of Object.entries(storage.records)) {
      const memberPositionLists = record.members.map((member) => positionsByHash.get(member.hash));
      if (memberPositionLists.some((positions) => positions === undefined)) {
        continue;
      }

      const positionsForBoundingBox = this.chooseBoundingBoxPositions(record.members, positionsByHash);
      const minStart = Math.min(...positionsForBoundingBox.map((p) => p.start));
      const maxEnd = Math.max(...positionsForBoundingBox.map((p) => p.end));

      // Exact verification, same as always: recompute the FULL combined
      // hash of everything CURRENTLY inside that bounding box, and require
      // it to match this record's own recordId precisely. A bounding box
      // stretched too wide by a coincidental leaf match elsewhere just
      // fails this check -- safe, since it can only ever produce a missed
      // match, never a wrong one.
      const matched = this.astService.filterByHighlight(allNodes, minStart, maxEnd);
      const sortedMemberHashes = matched
        .map((entry) => hashByKey.get(`${entry.type}:${entry.start}:${entry.end}`)!)
        .sort();
      const candidateRecordId = this.astService.hashNode(sortedMemberHashes);

      if (candidateRecordId === recordId) {
        found.push({ recordId, type: "Range", start: minStart, end: maxEnd, loc: null });
      }
    }

    return found;
  }

  // Picks, for each of a record's members, ONE current position to anchor
  // the bounding box on -- distinct positions for distinct member slots,
  // even when several members share the same hash (a param type and a
  // return type both being bare `: string`, say). A hash can have more
  // current positions than the record actually needs (some coincidentally
  // matching unrelated content elsewhere), so which ones are "this
  // record's own" has to be inferred rather than assumed.
  //
  // Members whose hash currently has EXACTLY as many occurrences as the
  // record needs are unambiguous by elimination -- claimed immediately,
  // wherever they are, with no guessing at all. Whatever remains ambiguous
  // is resolved by growing a bounding box outward from those unambiguous
  // anchors, always claiming whichever remaining candidate sits closest to
  // (or already inside) the box established so far, one at a time,
  // recomputing the box after each claim -- exactly what a comment
  // immediately preceding the function it annotates, or a return type
  // immediately following a param type, needs: neither is a sibling of
  // what it belongs with, so nothing about them is "contained" by the
  // other members up front, only "closest to". A record with NO
  // unambiguous member at all (every one of its members happens to also
  // exist elsewhere right now, with no elimination possible) has nothing
  // to grow from; every current position of every member is used instead
  // -- the exact hash verification the caller performs afterward is what
  // makes even that guess safe, since a wrongly stretched box only ever
  // fails it, never produces a wrong match.
  private chooseBoundingBoxPositions(
    members: RecordMember[],
    positionsByHash: Map<string, { start: number; end: number }[]>
  ): { start: number; end: number }[] {
    const neededByHash = new Map<string, number>();
    const poolByHash = new Map<string, { start: number; end: number }[]>();
    for (const member of members) {
      neededByHash.set(member.hash, (neededByHash.get(member.hash) ?? 0) + 1);
      if (!poolByHash.has(member.hash)) {
        poolByHash.set(member.hash, [...positionsByHash.get(member.hash)!]);
      }
    }

    const chosen: { start: number; end: number }[] = [];
    for (const [hash, needed] of neededByHash) {
      const pool = poolByHash.get(hash)!;
      if (pool.length === needed) {
        chosen.push(...pool);
        poolByHash.set(hash, []);
        neededByHash.set(hash, 0);
      }
    }

    if (chosen.length === 0) {
      return members.flatMap((member) => positionsByHash.get(member.hash)!);
    }

    const distanceToBox = (position: { start: number; end: number }, box: { minStart: number; maxEnd: number }) => {
      if (position.end <= box.minStart) return box.minStart - position.end;
      if (position.start >= box.maxEnd) return position.start - box.maxEnd;
      return 0;
    };

    while ([...neededByHash.values()].some((needed) => needed > 0)) {
      const box = {
        minStart: Math.min(...chosen.map((p) => p.start)),
        maxEnd: Math.max(...chosen.map((p) => p.end)),
      };

      let best: { hash: string; index: number; distance: number } | null = null;
      for (const [hash, needed] of neededByHash) {
        if (needed === 0) continue;
        const pool = poolByHash.get(hash)!;
        pool.forEach((position, index) => {
          const distance = distanceToBox(position, box);
          if (best === null || distance < best.distance) {
            best = { hash, index, distance };
          }
        });
      }

      if (best === null) break;
      const { hash, index } = best as { hash: string; index: number; distance: number };
      const pool = poolByHash.get(hash)!;
      chosen.push(pool[index]);
      pool.splice(index, 1);
      neededByHash.set(hash, neededByHash.get(hash)! - 1);
    }

    return chosen;
  }

  checkFile(repoPath: string, relativePath: string): FileCheckReport {
    const code = readFileSync(join(repoPath, relativePath), "utf-8");
    const { ast } = this.astService.parseSource(code, relativePath);

    if (!ast) {
      throw new Error("Cannot check file: failed to parse");
    }

    const allNodes = this.astService.walkAllNodes(ast.program.body);

    const currentHashes = new Set<string>();
    const hashedNodes: (UndocumentedNode & { hash: string; isLeaf: boolean })[] = [];
    // Shared across every record's anchor resolution below (mutated as each
    // one claims its own positions) -- see that pass's own comment for why
    // a single, depleting pool, not each record filtering the whole file
    // independently, is what makes cross-record disambiguation possible.
    const positionsByHash = new Map<string, { start: number; end: number }[]>();

    for (const entry of allNodes.values()) {
      const hash = this.astService.hashNode(entry.node);
      currentHashes.add(hash);
      const name = this.astService.extractName(entry.node);
      const isLeaf = isLeafNode(entry.node, entry.type);
      hashedNodes.push({ type: entry.type, start: entry.start, end: entry.end, loc: entry.loc, name, hash, isLeaf });
      const positions = positionsByHash.get(hash) ?? [];
      positions.push({ start: entry.start, end: entry.end });
      positionsByHash.set(hash, positions);
    }

    const storage = this.loadStorage(repoPath, relativePath);
    const documentedHashes = new Set<string>();
    const recordStatuses: { recordId: string; record: DocRecord; status: DriftResult["status"]; changedMembers: RecordMember[] }[] = [];

    for (const [recordId, record] of Object.entries(storage.records)) {
      for (const member of record.members) {
        documentedHashes.add(member.hash);
      }

      // A record's members are the FULL exploded set (every node, leaf and
      // compound, in the originally-documented span) -- naively checking
      // each member's hash against currentHashes (which has no notion of
      // POSITION, only "does this hash exist anywhere in the file") means a
      // record for code that's genuinely, entirely gone can still show a
      // stray "unchanged" leaf or two: a bare NumericLiteral like `1`, or a
      // common `TSNumberKeyword` (`: number`), reused by sheer coincidence
      // somewhere completely unrelated in the current file. Found for real:
      // a record documenting a since-deleted Fibonacci function kept
      // reporting "partially stale" against a completely rewritten,
      // unrelated Graph-utilities file, because 2-3 of its ~30-50 members
      // were bare number literals that happened to also appear, meaning
      // something else entirely, elsewhere in the new code.
      //
      // The fix: only trust a record's real structural anchors -- its
      // COMPOUND members -- to decide whether ANYTHING of substance
      // survived. If at least one compound member still fully matches
      // somewhere (a genuine, structurally-implausible-by-coincidence
      // anchor), the normal per-member check below is trustworthy exactly
      // as before. If NONE do, nothing of this record's actual content
      // survives, and any leftover bare-leaf "matches" are almost certainly
      // coincidence, not evidence -- the whole record is fully stale.
      //
      // Real edge case found via manual testing: a record can be made
      // ENTIRELY of leaf members -- documenting a single comment, say, which
      // has no substructure at all and so is itself always a leaf. Such a
      // record can never have a compound member to offer, by its own
      // composition, not because anything actually changed -- requiring one
      // unconditionally always marked it fully stale, even completely
      // untouched. The gate only makes sense when a compound anchor COULD
      // exist; when the record has none at all, there's nothing better to
      // fall back on than the ordinary per-member check.
      const hasCompoundMember = record.members.some((member) => !(member.isLeaf ?? ATOMIC_LEAF_TYPES.has(member.type)));
      const hasCompoundAnchor =
        !hasCompoundMember ||
        record.members.some(
          (member) => !(member.isLeaf ?? ATOMIC_LEAF_TYPES.has(member.type)) && currentHashes.has(member.hash)
        );

      const changedMembers = hasCompoundAnchor
        ? record.members.filter((member) => !currentHashes.has(member.hash))
        : record.members;

      let status: DriftResult["status"];
      if (changedMembers.length === 0) {
        status = "unchanged";
      } else if (changedMembers.length === record.members.length) {
        status = "fully_stale";
      } else {
        status = "partially_stale";
      }

      recordStatuses.push({ recordId, record, status, changedMembers });
    }

    // Anchor resolution: a SEPARATE pass, ordered from the most-intact
    // record to the least (fewest changed members first) and sharing ONE
    // depleting position pool across every record, not each one filtering
    // the whole file independently. Real bug this fixes: two documented
    // functions differing only by name (e.g. copy-pasted, then renamed)
    // have IDENTICAL params/body, so a per-record filter can't tell "my own
    // surviving node" apart from the sibling's merely-identical one, and
    // leaked the sibling's ranges into the renamed record's own
    // matchingRanges. Resolving the more-intact record FIRST and removing
    // its claimed positions from the shared pool means the more-ambiguous
    // record (the renamed one) is only left with its own real occurrence by
    // the time its turn comes -- the same "claim the unambiguous ones, grow
    // toward what's already claimed" strategy chooseBoundingBoxPositions
    // already uses within one record, just extended across records instead
    // of restarting fresh, independently, for each one. Anchors stay
    // restricted to COMPOUND members for the same reason undocumented-node
    // detection below is: an unchanged leaf (a reused identifier, say) is
    // not reliable evidence of where a record's content actually lives.
    const anchorsByRecordId = new Map<
      string,
      {
        name: string | null;
        matchingRanges: { start: number; end: number }[];
        collidesWith: { name: string; start: number; end: number }[];
      }
    >();
    const resolutionOrder = [...recordStatuses].sort((a, b) => a.changedMembers.length - b.changedMembers.length);

    // Finds the smallest current, NAMED container around one specific
    // position -- same "smallest container fully containing it" rule the
    // regular name-derivation below uses, just applied to a single point
    // instead of a merged min/max range, so a genuine collision can be
    // explained by name AND position ("division" at [12,45]) instead of
    // raw offsets alone. Returns the container's own full span, not the
    // tied member's tiny one, so a UI can navigate to/highlight the whole
    // colliding function.
    const findContainer = (position: { start: number; end: number }): { name: string; start: number; end: number } | null => {
      const containers = hashedNodes
        .filter((node) => node.name !== null && node.start <= position.start && position.end <= node.end)
        .sort((a, b) => a.end - a.start - (b.end - b.start));
      const match = containers[0];
      return match ? { name: match.name!, start: match.start, end: match.end } : null;
    };

    for (const { recordId, record } of resolutionOrder) {
      const survivingCompoundMembers = record.members.filter(
        (member) => currentHashes.has(member.hash) && !(member.isLeaf ?? ATOMIC_LEAF_TYPES.has(member.type))
      );

      if (survivingCompoundMembers.length === 0) {
        anchorsByRecordId.set(recordId, { name: null, matchingRanges: [], collidesWith: [] });
        continue;
      }

      // Refuse to guess when NOTHING about this record is unambiguous even
      // before growing a box outward -- chooseBoundingBoxPositions's own
      // fallback for that case (grab every current position of every
      // member) is only safe for findDocumentedNodes, which re-verifies the
      // exact combined hash afterward and silently drops a wrong guess; a
      // Problems warning has no equivalent verification step, so a
      // genuinely unanchored record must stay unanchored rather than risk
      // pointing at the wrong function entirely. Real case this covers:
      // TWO twins renamed at once (not just one) -- neither has a still-
      // unique name left to seed from, since the untouched twin that made
      // the single-rename case resolvable no longer exists.
      const neededByHash = new Map<string, number>();
      for (const member of survivingCompoundMembers) {
        neededByHash.set(member.hash, (neededByHash.get(member.hash) ?? 0) + 1);
      }
      const hasUnambiguousSeed = [...neededByHash].some(
        ([hash, needed]) => (positionsByHash.get(hash)?.length ?? 0) === needed
      );

      if (!hasUnambiguousSeed) {
        // Real, user-requested behavior (2026-08-12): don't just stay
        // silent about why -- name (and locate) every current container
        // this record's surviving content equally matches, so a UI can
        // explain the collision AND jump straight to each real candidate,
        // instead of leaving a user to discover either only by reading raw
        // storage JSON. Deduplicated by name (a Map, not a Set of objects)
        // since the same container is reachable via more than one tied
        // member -- one entry per real candidate location, not one per hash.
        const collidesWith = new Map<string, { name: string; start: number; end: number }>();
        for (const member of survivingCompoundMembers) {
          for (const position of positionsByHash.get(member.hash) ?? []) {
            const container = findContainer(position);
            if (container !== null) collidesWith.set(container.name, container);
          }
        }
        anchorsByRecordId.set(recordId, { name: null, matchingRanges: [], collidesWith: [...collidesWith.values()] });
        continue;
      }

      const chosenPositions = this.chooseBoundingBoxPositions(survivingCompoundMembers, positionsByHash);
      const claimed = new Set(chosenPositions);
      for (const [hash, positions] of positionsByHash) {
        if (positions.some((position) => claimed.has(position))) {
          positionsByHash.set(
            hash,
            positions.filter((position) => !claimed.has(position))
          );
        }
      }

      const minStart = Math.min(...chosenPositions.map((p) => p.start));
      const maxEnd = Math.max(...chosenPositions.map((p) => p.end));
      const containers = hashedNodes
        .filter((node) => node.name !== null && node.start <= minStart && maxEnd <= node.end)
        .sort((a, b) => a.end - a.start - (b.end - b.start));

      anchorsByRecordId.set(recordId, { name: containers[0]?.name ?? null, matchingRanges: chosenPositions, collidesWith: [] });
    }

    const driftResults: DriftResult[] = recordStatuses.map(({ recordId, record, status, changedMembers }) => {
      const { name, matchingRanges, collidesWith } = anchorsByRecordId.get(recordId)!;
      return {
        recordId,
        status,
        totalMembers: record.members.length,
        changedMembers,
        name,
        matchingRanges,
        collidesWith,
      };
    });

    const undocumentedCandidates = hashedNodes.filter((node) => !documentedHashes.has(node.hash));

    // A candidate whose current hash doesn't match anything documented is
    // NOT necessarily genuinely new -- it might just be the current,
    // changed shape of a node that still partially belongs to an existing
    // record (a FunctionDeclaration whose hash shifted because a new
    // sibling statement was added inside it, for instance). The signal for
    // "this is just a stale container, already covered by the warning
    // above" is structural: does it still CONTAIN at least one COMPOUND
    // node whose hash IS documented?
    const undocumentedNodes: UndocumentedNode[] = undocumentedCandidates
      .filter((candidate) => {
        const overlapsExistingRecord = hashedNodes.some(
          (other) =>
            !other.isLeaf &&
            documentedHashes.has(other.hash) &&
            candidate.start <= other.start &&
            other.end <= candidate.end
        );
        return !overlapsExistingRecord;
      })
      .map(({ type, start, end, loc, name, hash }) => ({ type, start, end, loc, name, hash }));

    return { driftResults, undocumentedNodes };
  }

  generateMessages(repoPath: string, relativePath: string, report: FileCheckReport): Message[] {
    const storage = this.loadStorage(repoPath, relativePath);
    const messages: Message[] = [];

    for (const drift of report.driftResults) {
      const record = storage.records[drift.recordId];
      if (!record) continue;

      const quoted = `"${this.snippet(record.docText)}"`;

      if (drift.status === "fully_stale") {
        messages.push({
          severity: "error",
          text: `${quoted} no longer matches any code in this file — it looks like this was removed or completely rewritten. Consider deleting this documentation or writing a new one.`,
          relativePath,
          recordId: drift.recordId,
          ranges: [],
          collidesWith: [],
        });
      } else if (drift.status === "partially_stale") {
        const distinctTypes = [...new Set(drift.changedMembers.map((member) => member.type))];
        const shown = distinctTypes.slice(0, 4);
        const remainder = distinctTypes.length - shown.length;
        const typesText = shown.join(", ") + (remainder > 0 ? `, and ${remainder} more` : "");

        // A real, current name (when one can be found) points straight at
        // the code -- a quoted docText snippet doesn't, since it's whatever
        // the user happened to type, not something you can search for or
        // recognize at a glance. Falls back to the docText quote only when
        // no name is derivable (an anonymous/unnamed piece of code).
        const subject = drift.name ? `"${drift.name}"` : quoted;

        // Real, user-requested behavior (2026-08-12): an empty
        // matchingRanges because of a genuine collision (drift.collidesWith
        // populated) is a fundamentally different situation from one
        // that's just missing a name -- staying silent about WHY forces
        // reading raw storage JSON to find out. Naming exactly what it
        // collides with, and pointing at the real resolution mechanism
        // (the "Delete stale documentation" Quick Fix, the only thing that
        // can actually reach a record in this state), turns a dead end
        // into an actionable next step.
        const collisionText =
          drift.collidesWith.length > 0
            ? ` Its location is ambiguous: it matches the same structure as ${drift.collidesWith.map((c) => `"${c.name}"`).join(", ")}. Use "Delete stale documentation" to remove this record and redocument, or to remove all but the one you want to keep.`
            : "";

        messages.push({
          severity: "warning",
          text: `${subject} is partially out of date — ${drift.changedMembers.length} of ${drift.totalMembers} parts changed (${typesText}), but the rest is still accurate. Review and update if needed.${collisionText}`,
          relativePath,
          recordId: drift.recordId,
          ranges: drift.matchingRanges,
          collidesWith: drift.collidesWith,
        });
      }
    }

    const topLevelUndocumented = this.collapseToTopLevel(report.undocumentedNodes);
    for (const node of topLevelUndocumented) {
      const line = node.loc?.start.line;
      // Named when the node has a real identifier of its own (a function,
      // class, or variable name) -- falls back to the generic type-only
      // phrasing for anything without one (comments, expressions).
      const text = node.name
        ? `${node.type} "${node.name}" near line ${line ?? "?"} has no documentation yet.`
        : `A ${node.type} near line ${line ?? "?"} has no documentation yet.`;
      messages.push({
        severity: "info",
        text,
        relativePath,
        recordId: null,
        ranges: [{ start: node.start, end: node.end }],
        collidesWith: [],
      });
    }

    return messages;
  }

  private archiveRecord(repoPath: string, relativePath: string, record: DocRecord): void {
    const archive = this.loadArchive(repoPath);

    archive.push({
      id: randomUUID(),
      archivedAt: new Date().toISOString(),
      originalFileId: relativePath,
      docText: record.docText,
    });

    this.saveArchive(repoPath, archive);
  }

  private saveArchive(repoPath: string, archive: ArchivedRecord[]): void {
    const path = this.archivePathFor(repoPath);
    this.ensureDirFor(path);
    writeFileSync(path, JSON.stringify(archive, null, 2));
  }

  private archivePathFor(repoPath: string): string {
    return join(repoPath, STORAGE_DIR, ARCHIVE_FILENAME);
  }

  private walkJsonFiles(dir: string): string[] {
    const results: string[] = [];

    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return results;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        results.push(...this.walkJsonFiles(fullPath));
      } else if (entry.name.endsWith(".json")) {
        results.push(fullPath);
      }
    }

    return results;
  }

  private ensureDirFor(filePath: string): void {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  private snippet(text: string, maxLength = 60): string {
    return text.length > maxLength ? text.slice(0, maxLength) + "..." : text;
  }

  private collapseToTopLevel(nodes: UndocumentedNode[]): UndocumentedNode[] {
    return nodes.filter((node) => {
      const hasContainingParent = nodes.some(
        (other) =>
          (other.start !== node.start || other.end !== node.end) &&
          other.start <= node.start &&
          node.end <= other.end
      );
      return !hasContainingParent;
    });
  }
}
