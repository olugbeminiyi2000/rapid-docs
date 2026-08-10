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

**Re-audit pass (2026-08-10) found two more real gaps, since re-checked and closed:**
- [x] `canParseFile` — was never called anywhere in the extension (different from `AstService.parseSource`, which was already tested; this is `DocumentationService`'s own convenience wrapper). Now tested directly: `true` for a real, parseable file, `false` for a genuinely broken-syntax scratch file.
- [x] `listDocumentedFileIds` — was only ever exercised transitively inside `reconcile()`, never independently asserted. Now tested directly, twice: once confirming it includes a just-documented file, and again later confirming it tracks REAL current state, not a stale snapshot (correctly dropped the renamed-then-archived file A and picked up the newly-documented file B).

## Section 5: `SyncService` — CLOSED

- [x] `reconcile` — thoroughly tested (397, then 590 after the parser fix, sampled and confirmed legitimate), PLUS its own "deleted-but-still-documented file" loop specifically re-tested below (see third re-audit).

`sync()`'s four real branches, and the other three methods, all verified via `rapidDocs.testSyncService` against a disposable scratch git repo (real commits, a real `git mv` rename) plus real scratch files in the workspace:

- [x] `sync` — no-commits branch (0 messages, correct), first-ever-sync branch (real `fullScan`, found the real undocumented function, sync pointer confirmed set to the real current HEAD), already-up-to-date branch (0 messages on an immediate second call, correct), and a real commit-diff branch (a real `git mv` rename plus a new file, correctly detected the rename, migrated the existing documentation record's storage intact, and reported the one genuinely new undocumented function).
- [x] `handleFileEvent` — both branches: file exists (real undocumented-function message), file deleted (real archive entry created from a previously-documented file).
- [x] `handleRenameEvent` — real storage migration confirmed, existing record survived intact under the new path.
- [x] `checkFileOnDemand` — both branches: `null` for a small, already-documented file (correct no-op), and real messages (10,001, exactly right: 10,000 padding comment lines each a genuine undocumented node, plus the one real function) for a genuinely 100KB+ undocumented file, confirming the large-file skip/catch-up path fires for real, not just in the isolated Jest suite.

Skip/minified-density logic itself (not just the outcome) is already covered by `src/`'s own Jest suite; this section confirms the extension's own call path reaches it correctly, not a duplicate of that lower-level coverage.

**Real gap in the test's own cleanup, not `SyncService`:** the `handleRenameEvent` step's real migrated storage record was never explicitly discarded by the test, found afterward via `.rapid-docs/` still containing it and removed manually.

**Third re-audit pass (2026-08-10) found two more real gaps, both about the same untested shape (a committed deletion), since re-checked and closed:**
- [x] `GitService.diff()`'s `"D"` (deleted) status-letter parsing, and `sync()`'s own `diffResult.deleted` loop (calling `handleDeletedFile` per deleted path) — neither had ever been exercised by a real commit. The two commits made earlier only ever added/renamed/modified files, never deleted one. This is a genuinely different code path from `handleFileEvent`'s delete branch (already tested), which only ever sees a *live*, uncommitted filesystem delete, not a committed one. Fixed by adding a third commit (`git rm a-renamed.ts`) to the scratch repo and re-running `sync()`: correctly detected the deletion, correctly archived the previously-migrated documentation record.
- [x] `reconcile()`'s own "detect a deleted-but-still-documented file" loop (`listDocumentedFileIds` + `existsSync`), the one specifically meant to catch a file deleted while the app was closed, never committed, never seen by any live watcher either. The only prior `reconcile()` test (Section 1) ran against a repo with zero prior documentation, so this exact loop body had never actually executed with real data. Fixed: documented a new file, deleted it directly from disk (no git, no `handleFileEvent`), called `reconcile()`, confirmed it was correctly detected and archived.

This third pass is a genuine, useful pattern for future sections too: two passes had already closed Sections 4-6 and then found real gaps on re-check; this third pass found gaps specifically shaped like "a deletion, but through the ONE remaining path (a real commit) that hadn't been tried yet." When a method has multiple ways to reach the same outcome (live vs. committed, for instance), each real path needs its own check, not just one representative case.

## Section 6: `LiveWatchService` — CLOSED

- [x] `start()` — tested, watcher genuinely starts.
- [x] One real "messages" event — tested (a real file created on disk triggered a correct, accurate message within 1 second).
- [x] `stop()` — tested as part of the Section 1 lifecycle fix (called from `deactivate()`, confirmed to complete without throwing).

The remaining real-timing behaviors verified via `rapidDocs.testLiveWatchSection`, against a disposable scratch git repo with a production-realistic (500ms, matches `DEFAULT_CORRELATION_WINDOW_MS`) correlation window and a temporary local listener (removed afterward so it can never leak into later runs):

- [x] Rename correlation window — a real OS `renameSync` (not a simulated event) produced exactly ONE correlated "messages" event naming both the old and new relative paths, not two separate uncorrelated events.
- [x] Unlink-only (genuine delete, no matching add) — correctly fell through, once the correlation window elapsed, as a single event with just the one path, not wrongly paired with anything.
- [x] Rapid, near-simultaneous changes to two different files — each produced its own separate, correct event, confirmed no cross-contamination between them.
- [x] `deriveSourcePathFromStoragePath` (a collaborator's documentation arriving via `git pull`, only the `.rapid-docs/*.json` file changes, not the source) — verified through all three of its call sites, not just one: a storage file appearing (`add`), being modified (`change`), and being deleted (`unlink`) all correctly triggered a recheck of the real source file, not the storage path itself.

**Re-audit pass (2026-08-10) found two more real, subtler gaps, since re-checked and closed:**
- [x] Rename correlation was only proven in ONE direction by the original real-`renameSync` test (whichever order chokidar/the OS happened to report). The source has two separate matching loops, `handleAdd`'s search through `pendingUnlinks` and `handleUnlink`'s search through `pendingAdds`, and a single real rename only ever exercises one of them. Both are now triggered explicitly and independently (a controlled unlink-then-add pair, and a separate controlled add-then-unlink pair), each confirmed to correlate correctly.
- [x] The three storage-derivation call sites (`add`/`change`/`unlink`) were reduced from "only `add` tested" to all three, per above.

**A genuinely useful finding surfaced while closing gap 1, not a bug:** the first attempt used an aggressive 150ms test-only correlation window (to keep the test fast) and got a real, reproducible failure on the add-then-unlink direction. Diagnostic timestamps showed why: the `add` side's own timeout fired at +165ms while the `unlink` side wasn't even detected by chokidar until +169ms, a 4-millisecond miss caused by real Windows unlink-detection latency (~109ms measured on this machine) leaving too little headroom under a 150ms window. Re-run with the real production default (500ms) passed cleanly and reliably. Conclusion, confirmed rather than assumed: the correlation logic itself was never broken; a test-only window tighter than the shipped default undershot real OS event latency. Worth remembering if `DEFAULT_CORRELATION_WINDOW_MS` is ever tuned down in `src/` later, this is the real-world latency budget it needs to keep clearing.

**Fourth re-audit pass (2026-08-10), a different method this time:** rather than re-reading the same `src/` files again, the real, existing Jest suite (`ast.service.spec.ts`, `git.service.spec.ts`, `documentation.service.spec.ts`, `sync.service.spec.ts`, `live-watch.service.spec.ts`, written during the original Electron build) was cross-referenced scenario-by-scenario against what the extension's own tests actually exercise. This surfaced far more untested scenarios than the first three source-reading re-audits combined, but most were pure input variations of an already-proven mechanism (e.g. `extractName` on other node types, `hashNode`'s whitespace/CRLF-invariance, `diff()` categorizing several change types within one combined commit) — since the underlying `src/` code is byte-identical either way and the Jest suite already guarantees those input variations on every commit, they were judged lower-risk and not individually re-tested. Seven were genuinely different code paths or mechanisms never touched by the extension at all, and were closed:

- [x] `LiveWatchService` never watching a gitignored directory's contents at all — real, previously-fixed-bug territory (the whole gitignore-watching performance investigation earlier in the project), completely unverified in the extension until now. Tested: committed a `.gitignore` ignoring `ignored-dir/` before `start()`, then wrote a brand-new file inside it after `start()` — zero events fired, confirming exclusion from the watch set itself, not just post-hoc filtering.
- [x] `DocumentationService.writeDoc` refusing to document the exact same highlight twice — a real duplicate-prevention guard, never exercised. Confirmed: a second `writeDoc` call with the identical selection threw.
- [x] `findRecordForSelection` finding a record via a selection *looser* (wider) than the exact documented node boundary — the actual real-world use case (a human drag-selection essentially never lands on an AST node's precise boundary); only an exact-match case had been tested before. Confirmed with a file whose documented span deliberately excluded trailing blank lines, queried with a selection that included them: still found, still matched.
- [x] `reconcile()` deliberately NOT correlating an uncommitted rename (unlike `sync()`'s git-diff-based rename detection) — a real, deliberate architectural distinction, never confirmed. Confirmed: a documented file renamed via raw filesystem calls (no `git mv`) was reported by `reconcile()` as an archived deletion of the old path PLUS an unrelated undocumented-file message for the new path, not a correlated rename.
- [x] Crash-safety: a full scan continuing past one unparseable file and still checking every other file, and `handleFileEvent` not crashing on a live edit that makes a file unparseable — real safety guarantees, never tested. Confirmed against a dedicated scratch repo containing both a valid and a genuinely broken file: the valid file was still flagged, and the live-edit path returned a real message instead of throwing.
- [x] `sync()`'s own diff loop AND `fullScan()` actually reaching the shared large-file skip logic (previously only `checkFileOnDemand` had been confirmed to reach it) — matches this section's own stated purpose of confirming every caller reaches the shared logic, not just one. Both confirmed: a large, undocumented file added via a real commit diff was skipped, and the same held inside a fresh repo's first-ever `fullScan`.
- [x] A representative error-throwing path, `deleteRecord` throwing for a nonexistent record id — every previous `DocumentationService` test only exercised success paths. Confirmed: it threw.

All seven verified via updated `rapidDocs.testDocumentationService`, `rapidDocs.testSyncService`, and `rapidDocs.testLiveWatchSection` runs, each new assertion checked against its exact expected value in the resulting proof file, no `ERROR:` lines in any of the three.

**All six backend sections (1-6) are now CLOSED, re-audited four times over (three source-reading passes plus one independent Jest-suite cross-reference), and holding up.** The entire reused backend, every method across `AstService`, `GitService`, `DocumentationService`, `SyncService`, and `LiveWatchService`, is proven working for real inside the Extension Host, with concrete evidence for each, not assumed from the isolated Jest suite or from "it compiled." Section 7 (UI layer) can now proceed on a fully verified foundation.

## Section 7: UI layer — IN PROGRESS (Sections 2-6 closed and four-times re-audited, no longer blocking)

**Method for this section, agreed 2026-08-10:** a full, line-by-line audit of the real Electron UI (`electron/renderer.js`, 1858 lines, plus `index.html`/`styles.css`) was done before writing any Section 7 code, specifically to avoid the "one UI piece at a time, missed a real gap" mistake from Sections 1-6's first pass. Every real feature found is listed below in dependency order (7.1 → 7.9), same discipline as Sections 1-6: a sub-item is only checked once verified with real evidence, never "looks right." **Everything is Webview, not TreeView** — a decision made explicitly 2026-08-10 because TreeView's native list styling isn't flexible enough to build on later; this REOPENS Documented Sections (7.2 below), which had been built as a TreeView and briefly marked done. **Full retest, no exceptions** — Diagnostics and Decorations (7.1 below) already have real evidence from earlier, but get re-confirmed here too, same as everything else, per explicit instruction: treat this like starting from scratch.

### 7.1: Foundation — CLOSED
- [x] **Modular architecture, done before any Section 7 UI code was written** — explicit user requirement 2026-08-11 ("modularity is really key," specifically rejecting `electron/renderer.js`'s ~1900-line jumbled style). `extension.ts` (previously ~1200 lines, everything inline) split into: `types.ts` (shared service/message interfaces), `backend/bootstrap.ts` (the dynamic-import + DI wiring), `diagnostics/diagnosticsController.ts`, `documented-sections/documentedSectionsProvider.ts`, `webviews/shared/getNonce.ts` + `webviews/shared/webviewShell.ts` (reusable themed-HTML + CSP base every future webview reuses), `webviews/testFoundation/testFoundationViewProvider.ts`, and `test-commands/*.ts` (one file per section's proof-file tests, kept fully separate from real UI code). `extension.ts` is now a thin ~70-line orchestrator. Verified with real evidence, not just "it compiled": ran `rapidDocs.testBackend` (real commit hash returned, confirming the refactored `bootstrap.ts` still wires the DI graph) plus all 10 remaining Section 1-6 test commands (Reconcile, Diagnostics, Live Watch, Write Doc, Decorations, AstService, GitService, DocumentationService, SyncService, LiveWatchService) -- every proof file matched pre-refactor values exactly, no regressions.
- [x] **Webview infrastructure** — a real `WebviewView` (`TestFoundationViewProvider`), themed entirely from VSCode's own CSS variables via the shared `webviewShell.ts` helper (confirmed visually to match the real VSCode theme, same technique Claude Code's own panel uses), with real two-way message passing verified end to end: a button click posts a message to the extension host, which writes a proof file and posts a reply back, which the webview's own DOM displayed -- confirmed via both the actual screenshot and the proof file, timestamps matching to the millisecond.
- [x] **Dedicated Activity Bar container** — decided 2026-08-11 after comparing to Claude Code's own panel placement: rather than share the Explorer sidebar (where the old TreeView lived), rapid-docs now has its own icon in VSCode's Activity Bar (`contributes.viewsContainers.activitybar`, a custom bolt-shaped SVG at `resources/icon.svg`, monochrome/`currentColor` so VSCode themes it), with Documented Sections and the webview-foundation test both moved under it. Confirmed via screenshot: icon renders correctly, both views appear grouped under "RAPID-DOCS" when clicked.
- [x] **Diagnostics (Problems + old Dashboard), re-confirmed and the live-wiring gap closed** — real gap found and fixed: previously Diagnostics only ever populated via the manual `rapidDocs.testDiagnostics`/`testReconcile` commands, never automatically. `diagnosticsController.ts` gained `activateDiagnosticsLiveWiring()`, matching `electron/main.ts`'s real `activateRepo()` sequence exactly (`sync()` + `reconcile()`, deduped via the same `severity::relativePath::text` key electron's own `dedupeMessages` uses, populate Diagnostics, then stop/restart `LiveWatchService` and subscribe its `"messages"` event to keep Diagnostics live-updated per `relativePaths`' documented "replace, not append" contract). Wired into `activate()`. Confirmed with real evidence: relaunched with NO manual test command run at all, Problems panel showed 822 real diagnostics immediately on activation; clicked one, correctly jumped to the exact line/column in the file.
- [x] **Decorations (documented-region highlighting), re-confirmed; severity-tinted decision made** — real `TextEditorDecorationType` still confirmed working. Resolved the open question with real user evidence, not just reasoning: after jumping to a diagnostic, the only visual cue was VSCode's own native current-line highlight, which the user found too subtle to reliably notice ("the highlighting is kind of one kind it is dark you cannot easily know it is highlighted"). Decided: a severity-tinted decoration IS needed, matching Electron's real `HIGHLIGHT_CLASS_BY_SEVERITY` (documented/warning/info, one distinct color each). Explicitly rejected programmatically overriding the user's global `editor.lineHighlightBackground` setting instead -- that would silently recolor the current-line highlight in every file the user ever opens, not just rapid-docs', a real, intrusive side effect outside rapid-docs' own scope. The click-to-toggle mechanism itself is implemented as part of 7.2's "single-highlight-toggle" item below, not duplicated here, since it's the same cross-cutting behavior for both documented sections and drift problems.

### 7.2: Documented-region interactions — NOT STARTED (rebuild, previously TreeView)
- [ ] **Documented Sections Webview** — rows (line range + text), click-to-reveal+select, inline Edit (swap row for a text input), Delete. Rebuilds `rapid-docs/src/documented-sections`-equivalent UI as a Webview instead of the `TreeView` built earlier; all 3 already-proven Section 4 backend calls (`findDocumentedNodes`, `editDocText`, `deleteRecord`) get rewired, not re-verified at the backend level.
- [ ] **Click inside a highlighted documented region in the real editor → select + reveal + toggle** (`renderer.js:220-240`) — genuinely missing feature found during the audit, not previously tracked at all. Needs `vscode.window.onDidChangeTextEditorSelection`, checking whether a collapsed-cursor click landed inside a currently-decorated range.
- [ ] **Single-highlight-toggle** — only one documented region (or drift problem) highlighted at a time; clicking its row/click-point again turns it off; clicking a different one replaces it. Current `testDecorations` just paints every region unconditionally — real behavioral gap, not yet designed for the extension.

### 7.3: Compose flow — NOT STARTED
- [ ] **Compose Webview, as a `WebviewPanel` (editor tab), not a sidebar `WebviewView`** — decided 2026-08-11: user wants the compose UI opened in a second editor column (`vscode.ViewColumn.Beside`) alongside the source file, not squeezed into the sidebar, specifically so code and the compose form are visible at the same time without switching. Real validation (file open? selection non-empty? text non-empty?), button label swap ("Document Selection" ↔ "Update Documentation"), friendly-error mapping (e.g. "already documented" → "use Edit instead"). `testWriteDoc` currently only writes a hardcoded placeholder string; this is the actual reason the whole project exists and doesn't exist yet.
- [ ] **`pendingDriftUpdate`-equivalent state machine** — set when "Update documentation (code changed)" is invoked, consumed by the next compose submission (routes to `updateDriftedDoc` instead of `writeDoc`), cleared by Edit/Delete from either the context menu or the Documented Sections list.

### 7.4: Editor right-click context menu — NOT STARTED
- [ ] **Native `editor/context` menu contribution** (Edit documentation / Delete documentation / Update documentation (code changed) / Document selection / Copy) — uses VSCode's own native context menu (confirmed via the Claude Code screenshot precedent: "Add File to Chat"/"Explain"/"Review" are the same mechanism), not a custom-built one. Real design work: a context key (`rapidDocs.selectionState` or similar), set via `setContext` on every selection change, driven by real `findRecordForSelection`/`findStaleRecordForSelection` calls (backend-authoritative, not a client-side position guess — this exact bug existed in Electron and was fixed there for the same reason), with `when` clauses per menu item.
- [ ] Tab-strip right-click (Close/Close Others/Close to the Right/Close All) — fully native VSCode behavior already; confirm with one real right-click, no code to write.

### 7.5: Archive Webview — NOT STARTED
- [ ] **Archive Webview** — list of archived `docText` entries with origin path, Discard button, click-to-select-as-pending, a separate "Attach here" bar/button that attaches the selected archive entry onto the current real editor selection. Depends on 7.3's real selection-reading logic.

### 7.6: Problems/Activity panel redesign — NOT STARTED (needs a real design decision first)
- [ ] **Decide**: does native `DiagnosticCollection` alone cover Problems, or does checkbox-select + Clear Selected/Clear All + an inline Delete button on fully-stale (error-severity) rows need a supplementary Webview? Native Diagnostics has none of those three.
- [ ] **Activity Webview** — a persistent, clearable, checkbox-select-able log of this session's document/edit/error attempts. Native Notifications only give ephemeral toasts, not a list — real gap, not yet built.
- [ ] Dashboard tab — already superseded (native Diagnostics' all-files toggle), no work needed, just note it as consciously dropped.

### 7.7: Repo/workspace re-confirmation — NOT STARTED (mostly verification, not building)
- [ ] Empty state / Recent Workspaces re-confirmed against a **real multi-root workspace** — flagged early, never actually resolved, still open.
- [ ] **Heavy-repo freeze risk** — Electron's `repoOpenInProgress` guard + spinner existed because a heavy synchronous git scan could make the whole main process "Not Responding." Our NestJS backend calls run synchronously inside the Extension Host too — never actually tested whether a big real repo can freeze VSCode's UI the same way, and if so, whether a `vscode.window.withProgress` (or similar) guard is needed anywhere.

### 7.8: Top-bar menu / keyboard shortcuts — NOT STARTED (closing out prior "reasoned through" claims)
- [ ] Theme toggle, Switch repository, Close repository, Open panel + their 4 keyboard shortcuts (Ctrl+Shift+T/O/W/I) — reasoned as superseded by native theming + native Open/Close Folder, but never reconfirmed with real evidence (same open item Section 8 has flagged since the start).

### 7.9: Full regression pass — NOT STARTED
- [ ] Once 7.1-7.8 are each individually closed, one final pass re-testing ALL of Section 7 together for real, end to end, exactly like the four backend re-audits did for Sections 1-6, before Section 7 itself is marked CLOSED.

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
