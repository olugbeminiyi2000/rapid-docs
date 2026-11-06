// A minimal structural view of DocumentationService's real shape (see
// src/ast/documentation.service.ts), not the full root type -- this process
// only ever calls the ten methods tools.ts actually wraps, so there's no
// reason to duplicate the rest of that class's surface (loadStorage,
// listDocumentedFileIds, renameFile, etc.) here just because it exists.

export interface DocRecord {
  docText: string;
  members: { type: string; hash: string; isLeaf?: boolean }[];
}

export interface DriftResult {
  recordId: string;
  status: "unchanged" | "partially_stale" | "fully_stale";
  totalMembers: number;
  changedMembers: { type: string; hash: string }[];
  name: string | null;
  matchingRanges: { start: number; end: number }[];
  collidesWith: { name: string; start: number; end: number }[];
}

export interface UndocumentedNode {
  type: string;
  start: number;
  end: number;
  name: string | null;
  hash: string;
}

export interface FileCheckReport {
  driftResults: DriftResult[];
  undocumentedNodes: UndocumentedNode[];
}

export interface Message {
  severity: "info" | "warning" | "error";
  text: string;
  relativePath: string;
  recordId: string | null;
  ranges: { start: number; end: number }[];
  collidesWith: { name: string; start: number; end: number }[];
}

export interface ArchivedRecord {
  id: string;
  archivedAt: string;
  originalFileId: string;
  docText: string;
}

export interface DocumentationService {
  writeDoc(
    repoPath: string,
    relativePath: string,
    highlightStart: number,
    highlightEnd: number,
    docText: string
  ): { recordId: string; record: DocRecord };

  findRecordForSelection(
    repoPath: string,
    relativePath: string,
    highlightStart: number,
    highlightEnd: number
  ): { recordId: string; docText: string } | null;

  findStaleRecordForSelection(
    repoPath: string,
    relativePath: string,
    highlightStart: number,
    highlightEnd: number
  ): { recordId: string; docText: string } | null;

  updateDriftedDoc(
    repoPath: string,
    relativePath: string,
    oldRecordId: string,
    highlightStart: number,
    highlightEnd: number,
    docText: string
  ): { recordId: string; record: DocRecord };

  editDocText(repoPath: string, relativePath: string, recordId: string, newText: string): void;

  deleteRecord(repoPath: string, relativePath: string, recordId: string): void;

  loadArchive(repoPath: string): ArchivedRecord[];

  attachArchivedRecord(
    repoPath: string,
    archiveId: string,
    relativePath: string,
    highlightStart: number,
    highlightEnd: number
  ): { recordId: string; record: DocRecord };

  discardArchivedRecord(repoPath: string, archiveId: string): void;

  checkFile(repoPath: string, relativePath: string): FileCheckReport;

  generateMessages(repoPath: string, relativePath: string, report: FileCheckReport): Message[];
}
