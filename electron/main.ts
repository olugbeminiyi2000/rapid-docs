import electron from "electron";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const { app, BrowserWindow, dialog, ipcMain, Menu } = electron;

// rapid-docs is deliberately not a code editor -- Electron's automatic
// default menu (Edit/View/Window, Undo/Redo, DevTools, zoom, etc.) is mostly
// irrelevant to what this app actually does and reads as an unbranded
// prototype. No custom replacement is added either; the app's own top bar
// and nav rail are the only navigation surface.
Menu.setApplicationMenu(null);

const SOURCE_FILE_PATTERN = /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/;

// The active repo and GitService instance, set once bootstrapEngine() resolves
// them -- module-scoped so the files:list/files:read handlers (registered
// once, but invoked later, whenever the renderer actually asks) can reach the
// current state rather than whatever was true at registration time.
let activeRepoPath: string | null = null;
let activeGitService: any = null;
let activeDocumentationService: any = null;
let activeSyncService: any = null;
let activeLiveWatchService: any = null;
let activeWorkspaceService: any = null;

// Set once createWindow() runs, read later by the liveWatchService listener
// to push messages -- the renderer can arrive and ask for catch-up messages
// whenever its own script finishes loading (pull), but live messages have no
// natural "ask" moment, so main has to push them the instant they occur, to
// whichever window is currently open.
let mainWindow: electron.BrowserWindow | null = null;

// Populated once by bootstrapEngine's sync()+reconcile() catch-up pass.
// Pull-based deliberately: this list is fixed the moment bootstrap finishes,
// so there's no race to manage by having the renderer ask for it whenever it
// is ready, rather than trying to push it before the renderer might be
// listening.
let catchUpMessages: Message[] = [];

// Confirmed by real testing: when launched as a raw script path (electron.exe
// electron/dist/main.js) rather than a packaged app, Electron's own app-name
// auto-detection did NOT find this project's package.json ("rapid-docs"),
// and silently fell back to the generic "Electron" userData folder -- shared
// by any other unbranded Electron app on the same machine. Setting this
// explicitly is the robust fix, regardless of why auto-detection missed it.
app.setName("rapid-docs");

// Electron's OWN ipcMain.handle internally console.error()s a full stack
// trace ("Error occurred in handler for 'X': ...") any time a handler
// throws or rejects -- confirmed to be baked into Electron's compiled
// binary itself (grepped node_modules/electron for the message; it only
// matches inside electron.exe, no JS file to patch), so there's no public
// API to suppress it directly. The fix is the same principle as the git
// stderr fix (Objective 3.20 §131-132): stop crossing the IPC boundary with
// an actual rejection at all for expected, already-handled failures (a
// duplicate record, a missing file, "no repo active"), while preserving the
// exact same experience for the renderer. safeHandle always RESOLVES,
// wrapping a thrown error into a plain marker object instead of rejecting;
// invokeOrThrow (preload.ts) unwraps that marker and throws it locally, as
// a normal in-process JS exception that never touches Electron's IPC layer
// at all -- so every existing try/catch in renderer.js keeps working
// completely unchanged, and Electron has nothing left to log.
function safeHandle(channel: string, handler: (event: unknown, ...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (event: unknown, ...args: any[]) => {
    try {
      return await handler(event, ...args);
    } catch (error) {
      return { __rapidDocsError: true, message: error instanceof Error ? error.message : String(error) };
    }
  });
}

// Minimal proof of the IPC mechanism before designing the real channel
// surface: a webpage can never call this directly (contextIsolation keeps
// nodeIntegration off) -- it can only reach it through whatever the preload
// script explicitly exposed via contextBridge.
ipcMain.handle("ping", () => "pong");

// The file-browsing foundation: nothing else (selecting a highlight, writing
// a doc) is possible until the renderer can see a list of files and their
// content -- neither of which any existing service was ever built to hand
// back out, since every service only ever returns *derived* things (hashes,
// reports, messages), never raw source text.
// safeHandle, not a plain ipcMain.handle, for the same reason every other
// channel uses it (Objective 3.29): listWorkingTreeFiles shells out to git,
// which -- while unlikely -- CAN throw (a corrupted .git, say), and an
// uncaught throw here would both spam Electron's own internal console
// logging and reject on the renderer side with unfriendly raw error text,
// unlike every other channel's consistent, caught behavior.
safeHandle("files:list", () => {
  if (activeRepoPath === null || activeGitService === null) {
    return [];
  }

  return activeGitService
    .listWorkingTreeFiles(activeRepoPath)
    .filter((relativePath: string) => SOURCE_FILE_PATTERN.test(relativePath));
});

safeHandle("files:read", (_event: unknown, relativePath: string) => {
  if (activeRepoPath === null) {
    throw new Error("No repository is currently active.");
  }

  return readFileSync(join(activeRepoPath, relativePath), "utf-8");
});

// Checked by the renderer BEFORE opening a file in Monaco -- every doc/drift
// feature this app has depends on being able to parse the file at all, so a
// file that can't be parsed is refused rather than opened as inert plain
// text with every panel silently doing nothing for it.
safeHandle("files:canParse", (_event: unknown, relativePath: string) => {
  if (activeRepoPath === null || activeDocumentationService === null) {
    throw new Error("No repository is currently active.");
  }

  return activeDocumentationService.canParseFile(activeRepoPath, relativePath);
});

// A thin pass-through to DocumentationService.writeDoc -- the renderer
// supplies the highlight range (captured from a plain textarea's native
// selectionStart/selectionEnd, per the earlier tier-1-first decision) and the
// text; everything else (parsing, hashing, mirrored storage) is exactly the
// same engine already proven throughout this whole project.
safeHandle(
  "docs:writeDoc",
  (_event: unknown, relativePath: string, highlightStart: number, highlightEnd: number, docText: string) => {
    if (activeRepoPath === null || activeDocumentationService === null) {
      throw new Error("No repository is currently active.");
    }

    return activeDocumentationService.writeDoc(activeRepoPath, relativePath, highlightStart, highlightEnd, docText);
  }
);

// writeDoc deliberately refuses to overwrite an exact-match record, telling
// the caller to use editDocText instead -- these two channels are what make
// that instruction actually reachable from the UI, not just true in the
// service layer.
safeHandle(
  "docs:editDocText",
  (_event: unknown, relativePath: string, recordId: string, newText: string) => {
    if (activeRepoPath === null || activeDocumentationService === null) {
      throw new Error("No repository is currently active.");
    }

    activeDocumentationService.editDocText(activeRepoPath, relativePath, recordId, newText);
  }
);

safeHandle("docs:deleteRecord", (_event: unknown, relativePath: string, recordId: string) => {
  if (activeRepoPath === null || activeDocumentationService === null) {
    throw new Error("No repository is currently active.");
  }

  activeDocumentationService.deleteRecord(activeRepoPath, relativePath, recordId);

  // Deleting a record never touches the source file itself, so the
  // filesystem watcher (LiveWatchService) has nothing to fire on here -- a
  // deleted record's own Problems message would otherwise keep showing until
  // some unrelated future edit happens to recheck this file. Recomputing and
  // pushing right here, through the exact same messages:live path the
  // watcher itself uses, is what makes the message actually disappear the
  // moment the record it was about is gone.
  if (activeSyncService !== null) {
    const messages = activeSyncService.handleFileEvent(activeRepoPath, relativePath);
    replaceFileMessages([relativePath], messages);
    mainWindow?.webContents.send("messages:live", flattenMessages());
  }
});

// Called by the renderer right after opening a file -- catches up whatever
// the bulk startup/reconcile scan deferred for a large, undocumented file
// (see SyncService.LARGE_FILE_THRESHOLD_BYTES), the moment someone actually
// looks at the file it was deferred for. checkFileOnDemand returns null for
// every other case (already checked, or never skippable to begin with) --
// a genuine no-op, so this only pushes a live update when there was
// actually something new to report.
safeHandle("docs:ensureFileChecked", (_event: unknown, relativePath: string) => {
  if (activeRepoPath === null || activeSyncService === null) {
    throw new Error("No repository is currently active.");
  }

  const messages = activeSyncService.checkFileOnDemand(activeRepoPath, relativePath);
  if (messages !== null) {
    replaceFileMessages([relativePath], messages);
    mainWindow?.webContents.send("messages:live", flattenMessages());
  }
});

// findDocumentedNodes returns one entry PER MATCHED AST NODE, not one per
// logical highlight -- a single writeDoc call typically matches many nested
// nodes (a function declaration alone matched ~16 back in Phase 1/2), all
// sharing the same recordId but with different, nested start/end ranges.
// Collapsing to one row per recordId (the overall min-start/max-end span)
// here, plus attaching docText from loadStorage, gives the renderer exactly
// what the documented-sections list panel needs in one call -- combining two
// existing capabilities at the boundary, not a new one.
safeHandle("docs:findDocumentedNodes", (_event: unknown, relativePath: string) => {
  if (activeRepoPath === null || activeDocumentationService === null) {
    throw new Error("No repository is currently active.");
  }

  const locations = activeDocumentationService.findDocumentedNodes(activeRepoPath, relativePath);
  const storage = activeDocumentationService.loadStorage(activeRepoPath, relativePath);

  const byRecordId = new Map<string, { recordId: string; start: number; end: number }>();
  for (const loc of locations) {
    const existing = byRecordId.get(loc.recordId);
    if (existing === undefined) {
      byRecordId.set(loc.recordId, { recordId: loc.recordId, start: loc.start, end: loc.end });
    } else {
      existing.start = Math.min(existing.start, loc.start);
      existing.end = Math.max(existing.end, loc.end);
    }
  }

  return Array.from(byRecordId.values()).map((entry) => ({
    ...entry,
    docText: storage.records[entry.recordId]?.docText ?? "",
  }));
});

// Answers "does this exact selection already match a documented record?"
// via the same structural computation writeDoc itself uses -- deliberately
// NOT position-matching the current selection against findDocumentedNodes'
// reported node boundaries (a real drag selection essentially never lands
// exactly on an AST node's precise character position). Used by the code
// area's right-click menu to decide between Edit/Delete and Document.
safeHandle(
  "docs:findRecordForSelection",
  (_event: unknown, relativePath: string, highlightStart: number, highlightEnd: number) => {
    if (activeRepoPath === null || activeDocumentationService === null) {
      throw new Error("No repository is currently active.");
    }

    return activeDocumentationService.findRecordForSelection(activeRepoPath, relativePath, highlightStart, highlightEnd);
  }
);

// Counterpart to docs:findRecordForSelection for a selection that overlaps a
// PARTIALLY stale record instead of exactly matching an unchanged one -- lets
// the right-click menu offer "Update documentation (code changed)" in the
// case findRecordForSelection alone can never cover (a drifted record's hash
// can never exactly match current code again).
safeHandle(
  "docs:findStaleRecordForSelection",
  (_event: unknown, relativePath: string, highlightStart: number, highlightEnd: number) => {
    if (activeRepoPath === null || activeDocumentationService === null) {
      throw new Error("No repository is currently active.");
    }

    return activeDocumentationService.findStaleRecordForSelection(
      activeRepoPath,
      relativePath,
      highlightStart,
      highlightEnd
    );
  }
);

safeHandle(
  "docs:updateDriftedDoc",
  (
    _event: unknown,
    relativePath: string,
    oldRecordId: string,
    highlightStart: number,
    highlightEnd: number,
    docText: string
  ) => {
    if (activeRepoPath === null || activeDocumentationService === null) {
      throw new Error("No repository is currently active.");
    }

    const result = activeDocumentationService.updateDriftedDoc(
      activeRepoPath,
      relativePath,
      oldRecordId,
      highlightStart,
      highlightEnd,
      docText
    );

    // Same reasoning as docs:deleteRecord: this mutates storage without
    // touching the source file, so LiveWatchService has nothing to fire on
    // -- recompute and push right here, through the same messages:live path,
    // so the resolved warning disappears immediately instead of lingering
    // until some unrelated future edit happens to recheck this file.
    if (activeSyncService !== null) {
      const messages = activeSyncService.handleFileEvent(activeRepoPath, relativePath);
      replaceFileMessages([relativePath], messages);
      mainWindow?.webContents.send("messages:live", flattenMessages());
    }

    return result;
  }
);

// Pull side of the catch-up messages: whatever bootstrapEngine has already
// computed by the time the renderer asks, defaulting to an empty list if the
// renderer asks before bootstrap gets that far (e.g. while the repo-picker
// dialog is still open).
ipcMain.handle("messages:getCatchUp", () => catchUpMessages);

// Three thin pass-throughs to DocumentationService's existing archive
// methods -- same shape as docs:writeDoc, no new logic on the main-process
// side. attachArchivedRecord computes entirely fresh hashes against whatever
// selection the renderer supplies (which file and range are independent of
// where the archived text originally lived).
//
// safeHandle, not a plain ipcMain.handle -- loadArchive reads and JSON.parses
// a real file on disk, which can throw (e.g. a corrupted _archive.json), and
// this was the one archive channel not already using the app's consistent
// caught-error convention (Objective 3.29/3.42).
safeHandle("archive:list", () => {
  if (activeRepoPath === null || activeDocumentationService === null) {
    return [];
  }

  return activeDocumentationService.loadArchive(activeRepoPath);
});

safeHandle(
  "archive:attach",
  (_event: unknown, archiveId: string, relativePath: string, highlightStart: number, highlightEnd: number) => {
    if (activeRepoPath === null || activeDocumentationService === null) {
      throw new Error("No repository is currently active.");
    }

    return activeDocumentationService.attachArchivedRecord(
      activeRepoPath,
      archiveId,
      relativePath,
      highlightStart,
      highlightEnd
    );
  }
);

safeHandle("archive:discard", (_event: unknown, archiveId: string) => {
  if (activeRepoPath === null || activeDocumentationService === null) {
    throw new Error("No repository is currently active.");
  }

  activeDocumentationService.discardArchivedRecord(activeRepoPath, archiveId);
});

function createWindow() {
  mainWindow = new BrowserWindow({
    // Real evidence caught this: at 800x600, the file-list (220) +
    // documented-sections (260) + archive-panel (260) fixed-width columns
    // alone total 740px, squeezing content-pane to ~60px and causing it to
    // visually overlap with documented-sections -- 800x600 was fine for the
    // 2-3 column layout that existed when it was first chosen, but never
    // rechecked as columns were added since. Still scaffolding, not real
    // design, but it has to actually fit its own content.
    width: 1280,
    height: 800,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(join(__dirname, "index.html"));
}

// A ".git" folder is the one thing every real git repo has, regardless of
// commit history -- deliberately NOT requiring any commits to exist (a
// freshly `git init`-ed or brand-new empty GitHub repo is a completely
// legitimate, real state to point rapid-docs at; GitService.getHeadCommit
// handles the zero-commits case gracefully on its own).
function isGitRepo(candidatePath: string): boolean {
  return existsSync(join(candidatePath, ".git"));
}

// The OS folder-picker only ever appears as the direct result of clicking a
// button inside the app -- never automatically on launch. Shared by the
// renderer's "Open a repository" empty-state button and its "Switch
// repository" button, since picking a repo is exactly the same operation
// regardless of whether one was already active. Loops back to the picker
// with a native error box (rather than silently accepting, or throwing) if
// the chosen folder isn't actually a git repo.
async function pickRepoViaDialog(): Promise<string | null> {
  while (true) {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "Select a git repository for rapid-docs to document",
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const chosenPath = result.filePaths[0];

    if (!isGitRepo(chosenPath)) {
      dialog.showErrorBox(
        "Not a git repository",
        `"${chosenPath}" doesn't contain a .git folder. Pick a folder that is itself a git repository (it can be empty, with zero commits -- it just has to be a real repo).`
      );
      continue;
    }

    return chosenPath;
  }
}

// Startup only ever checks the persisted preference -- it never shows a
// dialog itself. If there's no repo remembered (or it's gone/moved since
// last time), this returns null and the renderer shows an in-app empty
// state with its own button, which triggers pickRepoViaDialog() exactly
// like "Switch repository" does. The previous behavior (auto-popping the
// OS dialog the instant the window opened, before the app was even visible)
// was a real, if minor, UX complaint -- this removes it structurally rather
// than just softening it.
function determineRepoPath(workspaceService: any, userDataDir: string): string | null {
  const lastRepoPath = workspaceService.getLastRepoPath(userDataDir);
  return lastRepoPath !== null && isGitRepo(lastRepoPath) ? lastRepoPath : null;
}

interface Message {
  severity: string;
  text: string;
  relativePath: string;
}

// sync()'s first-run full scan and reconcile()'s always-run disk-vs-storage
// comparison overlap on any currently-unresolved issue (an existing
// undocumented node, existing drift) -- confirmed by real testing, which
// showed the exact same message reported twice in one run. checkFile is a
// pure, repeatable read that doesn't "consume" a problem once reported, so
// both calls independently rediscover it every time. Deduping by exact
// content here (not in SyncService itself) keeps this a presentation concern,
// since sync() and reconcile() are each correctly reporting current reality.
// Keyed by relativePath too, not just severity+text -- two different files
// can produce byte-identical message text (e.g. two functions that each have
// their own undocumented node "near line 1"), and that must not collapse into
// one entry that silently hides one file's real problem.
function dedupeMessages(messages: Message[]): Message[] {
  const seen = new Set<string>();
  const result: Message[] = [];

  for (const message of messages) {
    const key = `${message.severity}::${message.relativePath}::${message.text}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(message);
    }
  }

  return result;
}

// The single source of truth for "what's currently wrong, and in which
// file" -- seeded once from the startup catch-up pass, then kept current by
// every live event from here on. A drift detector should show CURRENT
// problems, not a historical log: once a file's live messages come back
// clean, its entry here is removed entirely rather than left showing a
// stale, already-fixed warning forever.
const messagesByFile = new Map<string, Message[]>();

// relativePaths are the file(s) this batch is the CURRENT, complete answer
// for -- always cleared first, then repopulated from `messages` (which may
// legitimately add nothing back, if that file is now fully clean).
function replaceFileMessages(relativePaths: string[], messages: Message[]): void {
  for (const relativePath of relativePaths) {
    messagesByFile.delete(relativePath);
  }

  for (const message of messages) {
    const existing = messagesByFile.get(message.relativePath);
    if (existing) {
      existing.push(message);
    } else {
      messagesByFile.set(message.relativePath, [message]);
    }
  }
}

function flattenMessages(): Message[] {
  return Array.from(messagesByFile.values()).flat();
}

// Runs the full catch-up-then-watch sequence for a given repo -- shared by
// the initial boot and by switching repos later, since both need exactly the
// same thing: forget whatever was true before, find out what's true now.
async function activateRepo(repoPath: string): Promise<void> {
  activeRepoPath = repoPath;

  const syncReport = activeSyncService.sync(repoPath);
  const reconcileReport = activeSyncService.reconcile(repoPath);
  catchUpMessages = dedupeMessages([...syncReport.messages, ...reconcileReport.messages]);

  // A different repo has an entirely different set of files -- clearing
  // first (not just replacing the touched entries) prevents any leftover
  // message from the PREVIOUS repo lingering, even in the unlikely case both
  // repos happen to share a relativePath (e.g. "src/index.ts").
  messagesByFile.clear();
  replaceFileMessages([...new Set(catchUpMessages.map((message) => message.relativePath))], catchUpMessages);

  console.log(`rapid-docs: ${catchUpMessages.length} message(s) from initial catch-up for ${repoPath}:`);
  for (const message of catchUpMessages) {
    console.log(`  [${message.severity}] ${message.text}`);
  }

  // start() sets up a brand new chokidar watcher bound to this repoPath.
  // Without stopping whatever watcher already exists first, the OLD one
  // would keep running (and keep emitting "messages" for the OLD repo)
  // indefinitely -- nothing else ever references or closes it once start()
  // silently overwrites its own internal handle.
  await activeLiveWatchService.stop();
  await activeLiveWatchService.start(repoPath);
  console.log(`rapid-docs: now watching live for changes in ${repoPath}.`);
}

// Shared by workspace:switch (after the OS picker returns a path) and
// workspace:openPath (a path chosen directly from the Workspaces list) --
// both need exactly the same sequence once a target path is actually
// settled on: remember it as lastRepoPath (for next launch's auto-reopen),
// record it in the recent-repos list (for the Workspaces list itself), then
// activate it.
async function openRepoAndRecord(repoPath: string): Promise<void> {
  const userDataDir = app.getPath("userData");
  activeWorkspaceService.setLastRepoPath(userDataDir, repoPath);
  activeWorkspaceService.recordOpenedRepo(userDataDir, repoPath);
  await activateRepo(repoPath);
}

// Lets the renderer trigger the same folder-picker used at startup, at any
// later point -- the only way to reach a different repo before this was to
// quit and relaunch. Validates the choice is actually a git repo up front,
// rather than letting GitService's shelled-out git commands fail with an
// opaque error several calls later.
safeHandle("workspace:switch", async () => {
  const chosenPath = await pickRepoViaDialog();

  if (chosenPath === null) {
    return { switched: false, repoPath: activeRepoPath };
  }

  await openRepoAndRecord(chosenPath);

  return { switched: true, repoPath: chosenPath };
});

// Opens a specific path directly -- no OS dialog -- for the Workspaces
// list's own "click a recent repo" action. A recent entry can go stale
// (the folder was moved or deleted since it was last opened); this is
// checked explicitly rather than letting GitService's shelled-out git
// commands fail several calls later with an opaque error, matching
// workspace:switch's own validation.
safeHandle("workspace:openPath", async (_event: unknown, repoPath: string) => {
  if (!isGitRepo(repoPath)) {
    throw new Error(`"${repoPath}" no longer exists, or isn't a git repository anymore.`);
  }

  await openRepoAndRecord(repoPath);

  return { switched: true, repoPath };
});

safeHandle("workspace:listRecent", () => {
  return activeWorkspaceService.listOpenedRepos(app.getPath("userData"));
});

// Matches "Close Folder" in editors like VSCode: returns to the empty state
// in this same window (no new window involved), AND clears the persisted
// choice so relaunching doesn't silently reopen the repo just closed --
// previously the only persisted-state operation was "replace with a
// different repo," never "forget entirely."
safeHandle("workspace:close", async () => {
  if (activeLiveWatchService) {
    await activeLiveWatchService.stop();
  }

  activeRepoPath = null;
  catchUpMessages = [];
  messagesByFile.clear();

  activeWorkspaceService.clearLastRepoPath(app.getPath("userData"));
});

ipcMain.handle("workspace:getActiveRepoPath", () => activeRepoPath);

// sync() first (catches up on anything committed), then reconcile() (catches
// whatever's left over -- uncommitted changes made while the app was closed),
// then start live-watching for anything from this point forward. Both sync()
// and reconcile() are one-shot, blocking calls with no partial progress to
// show, so their results are combined into a single "here's what happened
// while you were away" reveal -- not two separate waves, and not delayed
// until live-watching (which doesn't "finish", it just starts listening).
async function bootstrapEngine(): Promise<void> {
  const { NestFactory } = await import("@nestjs/core");
  // electron/tsconfig.json is deliberately isolated from src/'s own tsconfig
  // (an intentional boundary, set up back when this shell was first built) --
  // these compiled outputs live in a separately-configured project with no
  // shared type information, so this is a genuine runtime-only boundary, not
  // a real type error to fix.
  // @ts-expect-error -- see comment above
  const { AppModule } = await import("../../dist/app.module.js");
  // @ts-expect-error -- see comment above
  const { WorkspaceService } = await import("../../dist/workspace/workspace.service.js");
  // @ts-expect-error -- see comment above
  const { SyncService } = await import("../../dist/sync/sync.service.js");
  // @ts-expect-error -- see comment above
  const { LiveWatchService } = await import("../../dist/sync/live-watch.service.js");
  // @ts-expect-error -- see comment above
  const { GitService } = await import("../../dist/git/git.service.js");
  // @ts-expect-error -- see comment above
  const { DocumentationService } = await import("../../dist/ast/documentation.service.js");

  const context = await NestFactory.createApplicationContext(AppModule, { logger: false });

  activeWorkspaceService = context.get(WorkspaceService);
  activeSyncService = context.get(SyncService);
  activeLiveWatchService = context.get(LiveWatchService);
  activeGitService = context.get(GitService);
  activeDocumentationService = context.get(DocumentationService);

  // Registered once, here -- activeLiveWatchService is a NestJS singleton
  // that outlives any single repo, so this listener stays attached across
  // repo switches too. Only stop()/start() (inside activateRepo) need to
  // happen per switch; re-registering this on every switch would stack up
  // duplicate listeners, each firing for every future live event.
  activeLiveWatchService.on("messages", (relativePaths: string[], messages: Message[]) => {
    for (const message of messages) {
      console.log(`  [live][${message.severity}] ${message.text}`);
    }
    // Push the FULL current snapshot, not just this batch's delta -- the
    // renderer replaces its whole panel with whatever it receives, which is
    // what makes a now-fixed file's warning disappear instead of lingering
    // forever alongside messages for files nobody has touched since startup.
    replaceFileMessages(relativePaths, messages);
    mainWindow?.webContents.send("messages:live", flattenMessages());

    // Separate from messages entirely -- messages can go from non-empty to
    // empty (a file becomes fully clean), which would otherwise be
    // indistinguishable from "nothing changed" to a renderer only watching
    // message content. relativePaths is the one always-reliable signal that
    // these specific files' CONTENT changed on disk just now, independent of
    // whatever messages resulted from checking them.
    mainWindow?.webContents.send("files:changed", relativePaths);
  });

  const userDataDir = app.getPath("userData");
  const repoPath = determineRepoPath(activeWorkspaceService, userDataDir);

  if (repoPath === null) {
    console.log("rapid-docs: no repository selected -- engine not started.");
    return;
  }

  console.log(`rapid-docs: bootstrapping engine for ${repoPath}`);
  await activateRepo(repoPath);
}

app.whenReady().then(async () => {
  createWindow();
  await bootstrapEngine();
});

app.on("window-all-closed", () => {
  app.quit();
});
