# VSCode Extension Parity Checklist

**Method (agreed 2026-08-10, mandatory going forward):** go section by section, in real dependency order, bottom-up. A section is only marked CLOSED once every real capability in it is verified with real evidence (a proof file, a screenshot, an exact value checked against ground truth), never just "looks right" or "compiles." This includes things that don't show up as a UI click, like resource cleanup, not just visible features. Do not start the next section until the current one is CLOSED. `electron/` and `src/` are never edited for extension-specific reasons, only for genuine, general bug fixes (like the `decorators-legacy` parser fix below); they stay as the untouched reference to check every section against.

**Section order, and why:** (1) Extension lifecycle, since every later test depends on it running cleanly. (2) `AstService`, the deepest leaf dependency. (3) `GitService`, the other leaf, independent of `AstService`. (4) `DocumentationService`, built on `AstService`. (5) `SyncService`, built on `GitService` + `DocumentationService`. (6) `LiveWatchService`, built on `GitService` + `SyncService`. (7) UI layer, built only once 1-6 are fully proven, since Archive/the right-click menu/the compose Webview all depend on `DocumentationService` methods that weren't tested yet when those UI pieces were first touched. (8) A final explicit confirmation pass on everything deliberately not ported.

---

## Section 1: Extension lifecycle — CLOSED

- [x] `activate()` fires for real (`onStartupFinished`), confirmed via a timestamped proof file, cross-checked against actual current time (not just "a file exists") on every single relaunch throughout this whole effort.
- [x] `NestFactory.createApplicationContext(AppModule)` succeeds inside the Extension Host, via the same dynamic-`import()` pattern `electron/main.ts`'s `bootstrapEngine()` uses (`import("../../dist/app.module.js")`, identical relative path depth).
- [x] `deactivate()` — **found completely empty, a real, previously-uncaught resource leak.** `LiveWatchService`'s watcher was never stopped and the Nest application context was never closed on shutdown; `electron/main.ts` never needed this (its whole OS process just exits), but an extension can deactivate without VSCode exiting at all. Fixed by hoisting `liveWatchService`/`appContext` to module scope so `deactivate()` can reach them, calling `.stop()` and `.close()`. Verified for real, not just reviewed: started the watcher via `testLiveWatch`, closed the Extension Development Host window, confirmed a proof file was written that only gets reached after BOTH awaited cleanup calls succeed without throwing.

## Section 2: `AstService` — CLOSED

All five real methods chained together against one self-contained sample (a real `@Injectable()`-decorated class with a `greet` method) via `rapidDocs.testAstService`, each asserted against a known-correct expected result, not just "didn't throw":

- [x] `ping()` — already exercised with real evidence during Section 1's DI-graph proof.
- [x] `parseSource` — `fatal=false`, real `ast` returned, 0 errors, on real decorator syntax. Re-confirms the `decorators-legacy` parser fix through this exact integration path, not just the isolated Jest suite.
- [x] `walkAllNodes` — found 18 real nodes from the sample, a plausible, non-zero, non-garbage count.
- [x] `extractName` — given the real `ClassMethod` node found by `walkAllNodes`, correctly returned `"greet"`, the actual real name, not a guess.
- [x] `filterByHighlight` — narrowed to the method's own byte range, returned 12 nodes, verified every one of them is genuinely contained (`start >= highlightStart && end <= highlightEnd`), not just counted.
- [x] `hashNode` — determinism confirmed (hashing the same real node twice produced the identical hash), distinctness confirmed (hashing a different real node produced a different hash).

## Section 3: `GitService` — CLOSED

All 7 real methods verified via `rapidDocs.testGitService`:

- [x] `getHeadCommit` — directly tested, returned `359137c1a134bff06a351de3f5418d7059ea4963`, confirmed to exactly match `git rev-parse HEAD`.
- [x] `listTrackedFiles` — 51 real files, confirmed `package.json` is among them.
- [x] `listWorkingTreeFiles` — 51 real files, same count as tracked (nothing currently untracked-but-not-ignored), confirmed `package.json` is among them.
- [x] `listIgnoredPaths` — 9 real entries, confirmed `node_modules` is among them.
- [x] `getLastSyncedCommit`/`setLastSyncedCommit` — real round-trip against a genuinely disposable scratch git repo (never touches this repo's own `.git/rapid-docs/last-sync.json`): confirmed `null` before any set, confirmed the exact written value `"abc123deadbeef"` came back after.
- [x] `diff` — checked against this repo's OWN real, current git history (`HEAD~1` vs `HEAD`, computed fresh at test time via raw `git` calls, not hardcoded hashes that would go stale). Expected changed files (from real `git diff --name-only`) matched the service's own result exactly.
- [x] `compareContent` — real similarity score (`50`) returned for genuinely similar content, `null` correctly returned for unrelated content.

**Real bug found in the test harness itself, not `GitService`:** the scratch-repo cleanup (`rmSync`) hit a genuine Windows `EPERM` (a file lock held on something inside `.git/` longer than expected), even after adding `maxRetries`/`retryDelay`. Fixed by making cleanup failure non-fatal (log and continue) so a stubborn OS-level lock can never again mask real test evidence gathered before it. Leftover scratch dirs cleaned up manually via PowerShell afterward.

## Section 4: `DocumentationService` — CLOSED, the big one

- [x] `writeDoc` — directly tested (`testWriteDoc`), real record written and confirmed via the Documented Sections tree.
- [x] `findDocumentedNodes` — directly tested, correct results shown in the tree and used for decorations.
- [x] `deleteRecord` — directly tested, confirmed via screenshot that real on-disk storage was genuinely emptied.
- [x] `loadStorage` — exercised directly as part of the Documented Sections collapsing logic.
- [x] `checkFile`/`generateMessages` — exercised transitively via `reconcile()` (590 real, sampled-and-verified messages), and directly via the drift scenario below.

The remaining 9 methods verified via `rapidDocs.testDocumentationService`, one real, sequential, multi-step scenario (not 9 isolated calls): a real function was written and documented, then genuinely drifted (one statement changed, one left untouched, producing a real `partially_stale` result, not a forced one), resolved, edited, renamed, deleted (producing a real archive entry), a second file independently deleted (a second real archive entry), then one archived entry reattached and the other discarded. Every step checked against the REAL result of the previous step, not a predicted value (e.g. `findStaleRecordForSelection` was called using the actual `matchingRanges` `checkFile` really returned, not a guessed range):

- [x] `findRecordForSelection` — exact-match selection correctly found the just-written record; a trivial 1-character selection correctly returned `null`.
- [x] `findStaleRecordForSelection` — using the real anchor range from a genuine `partially_stale` `checkFile` result, correctly found the drifted record.
- [x] `updateDriftedDoc` — old record confirmed gone from storage afterward, new record confirmed present.
- [x] `editDocText` — `docText` confirmed changed in storage afterward.
- [x] `renameFile` — old storage path confirmed gone, new storage path confirmed exists.
- [x] `handleDeletedFile` — real messages returned, storage file confirmed removed, tested independently on two different files.
- [x] `loadArchive` — both real archive entries (from the two `handleDeletedFile` calls) confirmed present.
- [x] `attachArchivedRecord` — new record created on fresh code carrying the EXACT correct `docText` through the whole earlier chain (write → drift → update → edit → rename → delete → archive → attach all preserved the text correctly), archive count confirmed to shrink by one.
- [x] `discardArchivedRecord` — entry confirmed no longer present in the archive afterward.

**Real gap in the test's own cleanup, not `DocumentationService`:** `attachArchivedRecord` legitimately creates a brand new storage record for its target file, which the test's cleanup hadn't accounted for (only the three scratch source files were removed, not the storage `attachArchivedRecord` itself created). Found by checking `.rapid-docs/` directly afterward rather than assuming cleanup was complete; removed manually via PowerShell.

## Section 5: `SyncService` — PARTIAL

- [x] `reconcile` — thoroughly tested (397, then 590 after the parser fix, sampled and confirmed legitimate).
- [ ] `sync` — **not tested.** This is the actual commit-based diff path, the one that runs on every real git commit, not just the one-time catch-up scan.
- [ ] `handleFileEvent` — **not tested.** The live-edit path.
- [ ] `handleRenameEvent` — **not tested.**
- [ ] `checkFileOnDemand` — **not tested.** Backs the "catch up a large/skipped file the moment it's opened" behavior.
- [ ] Skip/minified-density logic — untested in this context (though covered by `src/`'s own Jest suite, still worth a real check here since the extension is a different caller).

## Section 6: `LiveWatchService` — PARTIAL

- [x] `start()` — tested, watcher genuinely starts.
- [x] One real "messages" event — tested (a real file created on disk triggered a correct, accurate message within 1 second).
- [x] `stop()` — tested as part of the Section 1 lifecycle fix (called from `deactivate()`, confirmed to complete without throwing).
- [ ] Rename correlation window (add+unlink within the window = a rename, not a separate delete+add) — untested.
- [ ] Multiple file changes in quick succession — untested.
- [ ] Unlink-only (a genuine delete, no matching add) — untested.

## Section 7: UI layer — NOT STARTED (blocked on Sections 2-6 closing first)

- [x] **Diagnostics (Problems + old Dashboard)** — `vscode.languages.createDiagnosticCollection`, populated from `reconcile()`. Confirmed VSCode's native "active file only" filter toggle covers what used to be two separate Electron panels (Problems was per-file, Dashboard was all-files) with the exact same one collection, zero extra code. Click-to-navigate on a diagnostic entry is native VSCode behavior, not yet explicitly re-confirmed by us clicking one on purpose (low risk, standard behavior, but not yet ticked with our own evidence). Still only wired from `reconcile()`, not yet re-wired to also update live from `sync()`/`handleFileEvent` once Section 5 closes.
- [x] **Decorations (documented-region highlighting)** — real `TextEditorDecorationType`, themed via `diffEditor.insertedTextBackground`, tested end-to-end. Open design question, not yet decided: does a warning/info decoration (matching Electron's severity-tinted click-to-highlight) need to exist too, or does the native squiggle + native click-to-navigate already cover it? Leaning toward "already covered", not yet confirmed deliberately.
- [~] **Documented Sections `TreeView`** — list, click-to-reveal, copy, delete all done. Edit is NOT wired (blocked on Section 4's `editDocText`).
- [ ] **Archive `TreeView`** — not started, blocked on Section 4.
- [ ] **Right-click editor context menu** (Edit documentation / Delete documentation / Document selection / Update documentation (code changed) / Copy) — not started at all. Every test so far has gone through the Command Palette, not the real interaction path. Blocked on Section 4's `findRecordForSelection`/`findStaleRecordForSelection`.
- [ ] **Compose Webview** — not started. `testWriteDoc` writes a hardcoded placeholder string; the real "type your documentation" UI, the actual reason this whole project exists, doesn't exist yet. Blocked on Section 4's `updateDriftedDoc`/`editDocText`.
- [ ] **Activity** — no separate section needed; it's VSCode's native Notifications (`showInformationMessage`/`showWarningMessage`/`showErrorMessage`), used inline wherever a flow needs it. Not yet systematically checked against every real scenario the Electron Activity log covered (hints, successes, errors) — to be verified as each flow above gets built, not as its own phase.
- [ ] Keyboard shortcuts, if any new ones are wanted — not started, low priority.

## Section 8: Final confirmation pass on what's deliberately NOT ported — NOT STARTED

- [ ] `WorkspaceService` + `recent-repos.ts` — reasoned through (VSCode natively remembers/reopens the last folder), never re-confirmed against a real multi-root workspace scenario, the one open question flagged early on and never actually resolved.
- [ ] `determineRepoPath` (`electron/main.ts:420`) — same reasoning as above, same open question.
- [ ] 4 keyboard shortcuts (`electron/renderer.js:1738-1751`) — reasoned through, not re-confirmed.
- [ ] `localStorage` keys (theme/panel-height/panel-collapsed/file-list-width) — reasoned through, not re-confirmed.
- [ ] Custom `showContextMenu`/`hideContextMenu` — superseded by native menu contributions once Section 7's right-click menu is actually built; premature to close this out before that exists.
- [ ] Folder-tree collapse tracking, drag-resize handles — reasoned through, not re-confirmed.
- [ ] `dialog.showOpenDialog`/`showErrorBox` — reasoned through, not re-confirmed.

## Storage format (unchanged either way)

- [x] `.rapid-docs/<relativePath>.json` per-file records — confirmed working identically inside the Extension Host through incidental use across every section above (write/read/delete all exercised for real).
- [ ] Archive JSON file — untested (blocked on Section 4).
