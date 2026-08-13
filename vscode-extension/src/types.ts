// Shared structural types for the real backend services (src/*.service.ts,
// loaded via dynamic import in backend/bootstrap.ts) and the message shapes
// they produce. Kept minimal and structural (not imported from src/ itself,
// which is untyped compiled JS by the time it reaches here) -- just enough
// surface for what this extension actually calls.

export interface RawFoundNodeLike {
  type: string;
  start: number;
  end: number;
  loc: unknown;
  node: unknown;
}

// Matches the real shape SyncService/DocumentationService produce (see
// electron/preload.ts's RendererMessage) -- ranges are byte offsets into the
// file's raw text, not line/column.
export interface RapidDocsMessage {
  severity: "info" | "warning" | "error";
  text: string;
  relativePath: string;
  recordId: string | null;
  ranges: { start: number; end: number }[];
  // Every current, named location this message's subject collides with --
  // populated only when ranges came back empty because of a genuine tie.
  // Drives the native DiagnosticRelatedInformation list.
  collidesWith: { name: string; start: number; end: number }[];
}

export interface DocRecord {
  docText: string;
}

export interface Storage {
  records: Record<string, DocRecord>;
}

export interface ArchiveEntry {
  id: string;
  originalFileId: string;
  docText: string;
}

export interface DriftResult {
  recordId: string;
  status: "unchanged" | "partially_stale" | "fully_stale";
  matchingRanges: { start: number; end: number }[];
}

export interface CheckFileReport {
  driftResults: DriftResult[];
}

export interface SyncReport {
  messages: RapidDocsMessage[];
}

export interface GitService {
  getHeadCommit(repoPath: string): string | null;
  listTrackedFiles(repoPath: string): string[];
  listWorkingTreeFiles(repoPath: string): string[];
  listIgnoredPaths(repoPath: string): string[];
  getLastSyncedCommit(repoPath: string): string | null;
  setLastSyncedCommit(repoPath: string, commit: string): void;
  diff(
    repoPath: string,
    from: string,
    to: string
  ): { added: string[]; modified: string[]; deleted: string[]; renamed: { from: string; to: string }[] };
  compareContent(a: string, b: string): number | null;
}

export interface AstService {
  ping(): unknown;
  parseSource(source: string, fileName: string): { fatal: boolean; ast: unknown; errors: unknown[] };
  walkAllNodes(programBody: unknown): Map<string, RawFoundNodeLike>;
  extractName(node: unknown): string | null;
  filterByHighlight(nodes: Map<string, RawFoundNodeLike>, start: number, end: number): RawFoundNodeLike[];
  hashNode(node: unknown): string;
}

export interface DocumentationService {
  storagePathFor(repoPath: string, relativePath: string): string;
  canParseFile(repoPath: string, relativePath: string): boolean;
  writeDoc(repoPath: string, relativePath: string, start: number, end: number, docText: string): { recordId: string };
  findRecordForSelection(repoPath: string, relativePath: string, start: number, end: number): { recordId: string; docText: string } | null;
  findStaleRecordForSelection(repoPath: string, relativePath: string, start: number, end: number): { recordId: string; docText: string } | null;
  updateDriftedDoc(
    repoPath: string,
    relativePath: string,
    oldRecordId: string,
    start: number,
    end: number,
    docText: string
  ): { recordId: string };
  editDocText(repoPath: string, relativePath: string, recordId: string, docText: string): void;
  deleteRecord(repoPath: string, relativePath: string, recordId: string): void;
  renameFile(repoPath: string, fromRelativePath: string, toRelativePath: string): void;
  handleDeletedFile(repoPath: string, relativePath: string): RapidDocsMessage[];
  listDocumentedFileIds(repoPath: string): string[];
  loadStorage(repoPath: string, relativePath: string): Storage;
  loadArchive(repoPath: string): ArchiveEntry[];
  attachArchivedRecord(
    repoPath: string,
    archiveId: string,
    relativePath: string,
    start: number,
    end: number
  ): { recordId: string; record: DocRecord };
  discardArchivedRecord(repoPath: string, archiveId: string): void;
  checkFile(repoPath: string, relativePath: string): CheckFileReport;
  generateMessages(repoPath: string, relativePath: string, report: CheckFileReport): RapidDocsMessage[];
  findDocumentedNodes(repoPath: string, relativePath: string): { recordId: string; start: number; end: number }[];
}

export interface SyncService {
  sync(repoPath: string): SyncReport;
  reconcile(repoPath: string): SyncReport;
  handleFileEvent(repoPath: string, relativePath: string): RapidDocsMessage[];
  handleRenameEvent(repoPath: string, fromRelativePath: string, toRelativePath: string): RapidDocsMessage[];
  checkFileOnDemand(repoPath: string, relativePath: string): RapidDocsMessage[] | null;
}

export interface LiveWatchService {
  start(repoPath: string, correlationWindowMs?: number): Promise<void>;
  stop(): Promise<void>;
  on(event: "messages", listener: (relativePaths: string[], messages: RapidDocsMessage[]) => void): void;
  off(event: "messages", listener: (relativePaths: string[], messages: RapidDocsMessage[]) => void): void;
}

export interface DocumentedSectionItem {
  recordId: string;
  relativePath: string;
  start: number;
  end: number;
  docText: string;
  startLine: number; // 0-based
}
