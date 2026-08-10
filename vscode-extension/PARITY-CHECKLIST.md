# VSCode Extension Parity Checklist

**Foundational proof complete (verified, not assumed):** a minimal extension in this folder activates for real (`onStartupFinished`, confirmed via a timestamped proof file written to disk), registers commands that show up in and run from the Command Palette, correctly reads `vscode.window.activeTextEditor` (both the "no editor" and "real file + real selection" cases, confirmed via screenshots), and successfully creates a real `NestFactory.createApplicationContext(AppModule)` inside the Extension Host using the exact same dynamic-`import()` pattern as `electron/main.ts`'s `bootstrapEngine()`. A real `GitService.getHeadCommit()` call against this repo's own workspace folder returned `359137c1a134bff06a351de3f5418d7059ea4963`, confirmed to exactly match `git rev-parse HEAD`. The core hypothesis of this whole branch, that the backend is reusable as-is inside the Extension Host, is proven with real evidence.

**`SyncService`/`AstService`/`DocumentationService` proof complete:** `SyncService.reconcile()`, called for real against this repo's own workspace folder, returned 397 real messages, sampled and confirmed legitimate (e.g. `vscode-extension/src/extension.ts: A ImportDeclaration near line 1 has no documentation yet.`), not garbage. Expected and correct: this repo's own code has never had rapid-docs' own documentation feature used on it, so every undocumented node across the whole real, current working tree (including the just-created `vscode-extension/` folder itself) legitimately shows up. Confirms all three services are correctly wired and producing accurate results inside the Extension Host.

**`LiveWatchService` proof complete:** started for real against this repo's own workspace folder (`liveWatchService.start(repoPath)`), then a real, disposable source file (`livewatch-probe.ts`, a genuine `export function` with no documentation) was created directly on disk from outside VSCode. The watcher's `"messages"` event fired within 1 second, correctly identified the new file's relative path and reported an accurate message ("ExportNamedDeclaration \"probe\" near line 1 has no documentation yet."). Probe file removed afterward, working tree left clean. All five core backend services (`GitService`, `AstService`, `DocumentationService`, `SyncService`, `LiveWatchService`) are now proven working for real inside the Extension Host. Backend integration phase is complete.

**Diagnostics (Problems panel) proof complete, and a real core-engine bug found and fixed along the way:** `vscode.languages.createDiagnosticCollection` populated from real `reconcile()` output, byte-offset `ranges` correctly converted to line/column via a real `TextDocument.positionAt()`, confirmed showing up in VSCode's actual native Problems panel with correct per-file groupings. While testing this against rapid-docs' own source (the first time any form of rapid-docs had ever been pointed at itself), found that `AstService.parseSource` (`src/ast/ast.service.ts:49`) only enabled Babel's `"typescript"` plugin, not `"decorators-legacy"`, so every file using a NestJS decorator (`@Injectable`, `@Module`, `@Controller`, essentially every service/module file) failed to parse entirely. This was a real bug in shared `src/` logic, not extension-specific, so it was fixed directly (2 new regression tests added to `ast.service.spec.ts`, confirmed failing before the fix and passing after, full suite 177/177 green). Re-tested after the fix: every previously-failing file now parses correctly (590 real messages total, up from 397, since the previously-failing files now genuinely contribute their real undocumented-node counts instead of one bare error each).

**Decorations (documented-region highlighting) proof complete.** Confirmed there's no native VSCode equivalent for this specifically (Diagnostics only covers problems, nothing built-in shows "this code is fine and documented"), so a real `TextEditorDecorationType` was used, colored via the existing themed `diffEditor.insertedTextBackground` token rather than a hardcoded color, so it adapts to the user's actual theme. Tested end-to-end with real, self-created data: `rapidDocs.testWriteDoc` wrote one real documentation record via `documentationService.writeDoc()` against a real selection in `vscode-extension/src/extension.ts`, then `rapidDocs.testDecorations` called the real `findDocumentedNodes()` and correctly highlighted the exact same selected region, confirmed via screenshot. Test record removed afterward (`.rapid-docs/` directory deleted, confirmed via `Test-Path`, working tree left clean). All Diagnostics + decorations UI-layer proofs are now complete.

**Documented Sections `TreeView` proof complete.** Replicated `electron/main.ts`'s exact `docs:findDocumentedNodes` handler logic (collapsing `findDocumentedNodes()`'s one-entry-per-matched-node output to one row per `recordId`, attaching `docText` from a separate `loadStorage()` call, since neither of those two things is in `src/` alone), registered under the Explorer sidebar (`contributes.views.explorer`) rather than a dedicated activity-bar container, since that would need a real icon asset not yet worth the polish time at this stage. Click-to-reveal, inline copy (`vscode.env.clipboard`), and inline delete (`documentationService.deleteRecord`, live-refreshing the tree after) all confirmed working end-to-end via screenshots, including confirming the record was genuinely removed from real storage on disk. File-scoped (refreshes on `onDidChangeActiveTextEditor`), matching how the Electron panel was always scoped to the currently open file. Remaining: Archive `TreeView` (same shape, should be quick), and the one compose Webview (the actual reason this project exists, still just a hardcoded placeholder string via `testWriteDoc` right now).


Purpose: every real capability of the Electron app (`electron/`, `src/`), audited directly against the source, not from memory. `electron/` and `src/` are never edited while building this extension, they stay as the reference to check against. Check an item off only once the extension actually does the equivalent thing, verified against the real Electron behavior cited, not just "looks similar."

## Backend services (reused unchanged, imported from the shared compiled `dist/`)

- [ ] `GitService`: `getHeadCommit`, `listTrackedFiles`, `listWorkingTreeFiles`, `listIgnoredPaths`, `getLastSyncedCommit`/`setLastSyncedCommit`, `diff`, `compareContent`
- [ ] `AstService`: `parseSource`, `walkAllNodes`, `filterByHighlight`, `extractName`, `hashNode`
- [ ] `DocumentationService`: `writeDoc`, `findRecordForSelection`, `findStaleRecordForSelection`, `updateDriftedDoc`, `deleteRecord`, `editDocText`, `renameFile`, `handleDeletedFile`, `loadArchive`, `attachArchivedRecord`, `discardArchivedRecord`, `findDocumentedNodes`, `checkFile`, `generateMessages`
- [ ] `SyncService`: `sync`, `handleFileEvent`, `handleRenameEvent`, `reconcile`, `checkFileOnDemand`, skip/minified-density logic
- [ ] `LiveWatchService`: chokidar-based watcher, add/change/unlink handling, correlation window for renames

## Explicitly NOT ported (confirmed superseded by VSCode itself)

- [ ] `WorkspaceService` + `recent-repos.ts` (auto-reopen last repo, recent-repos list): VSCode already remembers/reopens the last folder per window natively. Open question, not yet resolved: multi-root workspaces.
- [ ] `determineRepoPath` (`electron/main.ts:420`): same reason.
- [ ] 4 keyboard shortcuts (`electron/renderer.js:1738-1751`, Ctrl+Shift+I/T/O/W): each controlled something that no longer exists.
- [ ] `localStorage` keys (`rapid-docs-theme`, `rapid-docs-panel-height`, `rapid-docs-panel-collapsed`, `rapid-docs-file-list-width`): custom layout state, no custom layout to persist.
- [ ] `showContextMenu`/`hideContextMenu` custom menu system: replaced by native `editor/context` menu contributions.
- [ ] Folder-tree collapse tracking, drag-resize handles: no custom tree/panel to manage.
- [ ] `dialog.showOpenDialog`/`showErrorBox` (`electron/main.ts`): VSCode's own "Open Folder"; `vscode.window.showErrorMessage` if still needed anywhere.

## UI surfaces needing a real VSCode-side implementation

- [ ] **File tree, tabs, editor, current-file tracking** → VSCode's own Explorer/tabs/editor; `vscode.window.activeTextEditor` + `onDidChangeActiveTextEditor`
- [ ] **Selection tracking** → `activeTextEditor.selection`
- [ ] **Right-click menu** (Edit documentation / Delete documentation / Document selection / Update documentation (code changed) / Copy) → `contributes.menus["editor/context"]`, one command per action, reusing `findRecordForSelection`/`findStaleRecordForSelection`/`beginDriftUpdate` logic
- [ ] **Problems panel** (`checkFile`/`generateMessages` output) → `vscode.languages.createDiagnosticCollection`
- [ ] **Inline highlighting** (documented/warning/undocumented regions) → `vscode.window.createTextEditorDecorationType`
- [ ] **Activity log** (every `addActivityEntry` call site, `electron/renderer.js`) → `vscode.window.showInformationMessage`/`showWarningMessage`/`showErrorMessage`, VSCode's own Notifications history replaces the custom tab
- [ ] **Documented sections** (`findDocumentedNodes`, click-to-reveal, edit/delete/copy per row) → sidebar `TreeView`, `view/item/context` menu contributions, `revealRange`/`selection` on click
- [ ] **Archive** (`loadArchive`, `attachArchivedRecord`, `discardArchivedRecord`) → sidebar `TreeView`
- [ ] **Compose/write-doc UI** (`writeDoc`, `updateDriftedDoc`, `editDocText`, the multi-line text the whole project exists for) → the one Webview, styled entirely with VSCode's own `--vscode-*` CSS variables, no separate design system
- [ ] **Keyboard shortcuts, if any new ones are wanted** → `contributes.keybindings`, shows up in VSCode's native Keyboard Shortcuts UI automatically

## Main-process lifecycle (`electron/main.ts`)

- [ ] `app.whenReady()` + `createWindow()` + `bootstrapEngine()` → extension `activate(context)`
- [ ] `app.on("window-all-closed")` → extension `deactivate()`, if any cleanup is genuinely needed (stopping the watcher)

## Storage format (unchanged either way)

- [ ] `.rapid-docs/<relativePath>.json` per-file records, archive JSON: no change needed, plain `fs` reads/writes already work identically inside the Extension Host
