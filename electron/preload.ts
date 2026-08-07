import electron from "electron";

const { contextBridge, ipcRenderer } = electron;

interface RendererMessage {
  severity: "info" | "warning" | "error";
  text: string;
  relativePath: string;
  recordId: string | null;
  ranges: { start: number; end: number }[];
}

// Counterpart to main.ts's safeHandle: a handler that caught an error now
// RESOLVES with { __rapidDocsError: true, message } instead of rejecting,
// specifically so Electron's own internal ipcMain.handle never sees a
// rejection to console.error() a stack trace about. This unwraps that
// marker back into a real, local JS throw -- one that never crosses the IPC
// boundary itself, so every existing try/catch in renderer.js keeps working
// exactly as before, with no changes needed there at all.
async function invokeOrThrow(channel: string, ...args: unknown[]): Promise<any> {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (result && typeof result === "object" && (result as any).__rapidDocsError) {
    throw new Error((result as any).message);
  }
  return result;
}

// The ONLY things the actual webpage ever gets access to -- never the raw
// ipcRenderer object itself, which would let any page script send arbitrary
// IPC messages. Each function here is a deliberately narrow, named door.
contextBridge.exposeInMainWorld("rapidDocs", {
  ping: (): Promise<string> => invokeOrThrow("ping"),
  listFiles: (): Promise<string[]> => invokeOrThrow("files:list"),
  readFile: (relativePath: string): Promise<string> => invokeOrThrow("files:read", relativePath),
  canParseFile: (relativePath: string): Promise<boolean> => invokeOrThrow("files:canParse", relativePath),
  ensureFileChecked: (relativePath: string): Promise<void> => invokeOrThrow("docs:ensureFileChecked", relativePath),
  writeDoc: (relativePath: string, highlightStart: number, highlightEnd: number, docText: string): Promise<unknown> =>
    invokeOrThrow("docs:writeDoc", relativePath, highlightStart, highlightEnd, docText),
  findDocumentedNodes: (relativePath: string): Promise<unknown[]> =>
    invokeOrThrow("docs:findDocumentedNodes", relativePath),
  findRecordForSelection: (
    relativePath: string,
    highlightStart: number,
    highlightEnd: number
  ): Promise<{ recordId: string; docText: string } | null> =>
    invokeOrThrow("docs:findRecordForSelection", relativePath, highlightStart, highlightEnd),
  findStaleRecordForSelection: (
    relativePath: string,
    highlightStart: number,
    highlightEnd: number
  ): Promise<{ recordId: string; docText: string } | null> =>
    invokeOrThrow("docs:findStaleRecordForSelection", relativePath, highlightStart, highlightEnd),
  updateDriftedDoc: (
    relativePath: string,
    oldRecordId: string,
    highlightStart: number,
    highlightEnd: number,
    docText: string
  ): Promise<unknown> =>
    invokeOrThrow("docs:updateDriftedDoc", relativePath, oldRecordId, highlightStart, highlightEnd, docText),
  editDocText: (relativePath: string, recordId: string, newText: string): Promise<void> =>
    invokeOrThrow("docs:editDocText", relativePath, recordId, newText),
  deleteRecord: (relativePath: string, recordId: string): Promise<void> =>
    invokeOrThrow("docs:deleteRecord", relativePath, recordId),
  getCatchUpMessages: (): Promise<RendererMessage[]> => invokeOrThrow("messages:getCatchUp"),
  onLiveMessages: (callback: (messages: RendererMessage[]) => void): void => {
    ipcRenderer.on("messages:live", (_event, messages) => callback(messages));
  },
  onFilesChanged: (callback: (relativePaths: string[]) => void): void => {
    ipcRenderer.on("files:changed", (_event, relativePaths) => callback(relativePaths));
  },
  listArchive: (): Promise<{ id: string; archivedAt: string; originalFileId: string; docText: string }[]> =>
    invokeOrThrow("archive:list"),
  attachArchivedRecord: (
    archiveId: string,
    relativePath: string,
    highlightStart: number,
    highlightEnd: number
  ): Promise<unknown> => invokeOrThrow("archive:attach", archiveId, relativePath, highlightStart, highlightEnd),
  discardArchivedRecord: (archiveId: string): Promise<void> => invokeOrThrow("archive:discard", archiveId),
  switchRepo: (): Promise<{ switched: boolean; repoPath: string | null }> => invokeOrThrow("workspace:switch"),
  openRepoPath: (repoPath: string): Promise<{ switched: boolean; repoPath: string }> =>
    invokeOrThrow("workspace:openPath", repoPath),
  listRecentRepos: (): Promise<string[]> => invokeOrThrow("workspace:listRecent"),
  closeRepo: (): Promise<void> => invokeOrThrow("workspace:close"),
  getActiveRepoPath: (): Promise<string | null> => invokeOrThrow("workspace:getActiveRepoPath"),
});
