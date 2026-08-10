import * as vscode from "vscode";
import { writeFileSync, mkdtempSync, rmSync, unlinkSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import type { GitService, DocumentationService, SyncService } from "../types";

export interface TestSyncServiceDeps {
  gitService: GitService;
  documentationService: DocumentationService;
  syncService: SyncService;
}

// Section 5 (SyncService): sync() [only reconcile() was tested before],
// handleFileEvent, handleRenameEvent, checkFileOnDemand, plus 4 real gaps
// found later via the Jest-suite cross-reference (sync()'s own diff-loop
// large-file skip, reconcile() NOT correlating an uncommitted rename, and
// resilience against one unparseable file in both a fullScan and a live
// edit). sync()'s real branches need actual git history under control, so a
// disposable scratch repo is used, never this real repo's own commits or
// sync pointer.
export function registerTestSyncService(context: vscode.ExtensionContext, deps: TestSyncServiceDeps): void {
  const { gitService, documentationService, syncService } = deps;

  const disposable = vscode.commands.registerCommand("rapidDocs.testSyncService", () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showWarningMessage("rapid-docs: no workspace folder open.");
      return;
    }
    const repoPath = folder.uri.fsPath;
    const lines: string[] = [];
    const scratchDir = mkdtempSync(join(tmpdir(), "rapid-docs-syncservice-scratch-"));
    const relSmall = "vscode-extension/src/__syncservice_test_small__.ts";
    const relLarge = "vscode-extension/src/__syncservice_test_large__.ts";
    const absSmall = join(repoPath, relSmall);
    const absLarge = join(repoPath, relLarge);

    try {
      // --- sync() branch 1: no commits yet ---
      execFileSync("git", ["init"], { cwd: scratchDir });
      execFileSync("git", ["config", "user.email", "test@rapid-docs.local"], { cwd: scratchDir });
      execFileSync("git", ["config", "user.name", "rapid-docs test"], { cwd: scratchDir });
      const reportNoCommits = syncService.sync(scratchDir);
      lines.push(`sync() with zero commits: ${reportNoCommits.messages.length} message(s) (expected 0)`);

      // --- sync() branch 2: first-ever sync -> fullScan ---
      writeFileSync(join(scratchDir, "a.ts"), "export function alpha() {\n  return 1;\n}\n");
      execFileSync("git", ["add", "."], { cwd: scratchDir });
      execFileSync("git", ["commit", "-m", "first"], { cwd: scratchDir });
      const reportFirstScan = syncService.sync(scratchDir);
      const pointerAfterFirst = gitService.getLastSyncedCommit(scratchDir);
      const headAfterFirst = gitService.getHeadCommit(scratchDir);
      lines.push(
        `sync() first-ever (fullScan): ${reportFirstScan.messages.length} message(s) (expected >=1, real undocumented function), pointer set correctly=${pointerAfterFirst === headAfterFirst}`
      );

      // --- sync() branch 3: already up to date ---
      const reportUpToDate = syncService.sync(scratchDir);
      lines.push(`sync() immediately again, no new commits: ${reportUpToDate.messages.length} message(s) (expected 0)`);

      // --- sync() branch 4: a real commit diff, WITH a rename + a modification, and real storage to migrate ---
      const { recordId: scratchRecordId } = documentationService.writeDoc(scratchDir, "a.ts", 0, "export function alpha() {\n  return 1;\n}\n".length, "Documents alpha.");
      execFileSync("git", ["mv", "a.ts", "a-renamed.ts"], { cwd: scratchDir });
      writeFileSync(join(scratchDir, "b.ts"), "export function beta() {\n  return 2;\n}\n");
      execFileSync("git", ["add", "."], { cwd: scratchDir });
      execFileSync("git", ["commit", "-m", "rename a, add b"], { cwd: scratchDir });
      const reportDiff = syncService.sync(scratchDir);
      const oldStorageGone = !existsSync(documentationService.storagePathFor(scratchDir, "a.ts"));
      const newStorageExists = existsSync(documentationService.storagePathFor(scratchDir, "a-renamed.ts"));
      const migratedStorage = documentationService.loadStorage(scratchDir, "a-renamed.ts");
      lines.push(
        `sync() real diff (rename a->a-renamed + add b): ${reportDiff.messages.length} message(s), old storage gone=${oldStorageGone}, new storage exists=${newStorageExists}, record survived migration=${!!migratedStorage.records[scratchRecordId]}`
      );

      // --- sync() branch 4b: a real commit that DELETES a tracked,
      // documented file -- neither GitService.diff()'s "D" status parsing
      // nor sync()'s own diffResult.deleted loop (calling handleDeletedFile)
      // had ever been exercised before this; handleFileEvent's delete
      // branch tested above is a completely different, LIVE-filesystem code
      // path, not this commit-based one. ---
      execFileSync("git", ["rm", "a-renamed.ts"], { cwd: scratchDir });
      execFileSync("git", ["commit", "-m", "delete a-renamed"], { cwd: scratchDir });
      const reportDeleteCommit = syncService.sync(scratchDir);
      const archiveAfterDeleteCommit = documentationService.loadArchive(scratchDir);
      const migratedFileArchived = archiveAfterDeleteCommit.some((e) => e.originalFileId === "a-renamed.ts");
      lines.push(
        `sync() real diff (commit deletes a-renamed.ts): ${reportDeleteCommit.messages.length} message(s), archived via diffResult.deleted loop=${migratedFileArchived}`
      );

      // --- reconcile()'s OWN "detect a deleted-but-still-documented file"
      // loop (listDocumentedFileIds + existsSync), specifically the gap
      // reconcile() exists to catch per its own doc comment: something
      // deleted while the app was closed, never committed, never seen live
      // by handleFileEvent either. The ONLY prior reconcile() test (Section
      // 1) ran against a repo with zero prior documentation, so this exact
      // loop body had never actually executed with real data before now. ---
      writeFileSync(join(scratchDir, "r.ts"), "export function rFunc() {\n  return \"r\";\n}\n");
      documentationService.writeDoc(scratchDir, "r.ts", 0, "export function rFunc() {\n  return \"r\";\n}\n".length, "Documents rFunc.");
      unlinkSync(join(scratchDir, "r.ts")); // real filesystem delete, no git, no handleFileEvent involved
      const reconcileReport = syncService.reconcile(scratchDir);
      const archiveAfterReconcile = documentationService.loadArchive(scratchDir);
      const rFileArchived = archiveAfterReconcile.some((e) => e.originalFileId === "r.ts");
      lines.push(
        `reconcile() detecting a deleted-but-still-documented file (r.ts, never committed, never seen live): ${reconcileReport.messages.length} message(s), archived=${rFileArchived}`
      );

      // --- sync() branch 4c: the diff loop specifically (not fullScan)
      // skipping a large, undocumented, newly-added file -- a different
      // code path from both fullScan (branch 2 above) and
      // checkFileOnDemand (tested below), never independently confirmed to
      // reach the same shared skip logic before now. ---
      const largePaddingDiff = "// padding\n".repeat(10_000);
      writeFileSync(join(scratchDir, "large-diff-undocumented.ts"), `${largePaddingDiff}export function largeDiffFunc() {\n  return 1;\n}\n`);
      execFileSync("git", ["add", "."], { cwd: scratchDir });
      execFileSync("git", ["commit", "-m", "add large undocumented file"], { cwd: scratchDir });
      const reportLargeDiff = syncService.sync(scratchDir);
      const largeFlaggedInDiff = reportLargeDiff.messages.some((m) => m.relativePath === "large-diff-undocumented.ts");
      lines.push(
        `sync() diff loop skip: newly-added large-undocumented file via a real commit diff (not fullScan) skipped=${!largeFlaggedInDiff} (expected true, i.e. NOT flagged)`
      );

      // --- reconcile() does NOT correlate an uncommitted rename. Unlike
      // sync()'s git-diff-based rename detection, reconcile() has no git
      // history to correlate against (nothing here was ever committed), so
      // a rename performed entirely while nothing was watching must be
      // indistinguishable from an unrelated delete + add. ---
      const contentRen = "export function renFunc() {\n  return \"ren\";\n}\n";
      writeFileSync(join(scratchDir, "ren-original.ts"), contentRen);
      documentationService.writeDoc(scratchDir, "ren-original.ts", 0, contentRen.length, "Documents renFunc.");
      unlinkSync(join(scratchDir, "ren-original.ts"));
      writeFileSync(join(scratchDir, "ren-new.ts"), contentRen); // raw fs rename, no git mv, no handleRenameEvent involved
      const reconcileRenameReport = syncService.reconcile(scratchDir);
      const archiveAfterRenameReconcile = documentationService.loadArchive(scratchDir);
      const originalArchived = archiveAfterRenameReconcile.some((e) => e.originalFileId === "ren-original.ts");
      const newFileFlaggedUndocumented = reconcileRenameReport.messages.some((m) => m.relativePath === "ren-new.ts");
      lines.push(
        `reconcile() on an uncommitted rename (no git mv involved): old path archived=${originalArchived}, new path flagged as unrelated undocumented file=${newFileFlaggedUndocumented} (expected both true -- reconcile does NOT correlate renames)`
      );

      // --- handleFileEvent: file exists (real check) ---
      writeFileSync(absSmall, "export function gamma() {\n  return 3;\n}\n");
      const eventExists = syncService.handleFileEvent(repoPath, relSmall);
      lines.push(`handleFileEvent (file exists): ${eventExists.length} message(s) (expected >=1, real undocumented function)`);

      // --- handleFileEvent: file deleted, with real prior documentation to archive ---
      documentationService.writeDoc(repoPath, relSmall, 0, "export function gamma() {\n  return 3;\n}\n".length, "Documents gamma.");
      unlinkSync(absSmall);
      const eventDeleted = syncService.handleFileEvent(repoPath, relSmall);
      const archiveAfterDelete = documentationService.loadArchive(repoPath);
      const hasGammaArchiveEntry = archiveAfterDelete.some((e) => e.originalFileId === relSmall);
      lines.push(`handleFileEvent (file deleted): ${eventDeleted.length} message(s), archived=${hasGammaArchiveEntry}`);
      if (hasGammaArchiveEntry) {
        const entry = archiveAfterDelete.find((e) => e.originalFileId === relSmall)!;
        documentationService.discardArchivedRecord(repoPath, entry.id);
      }

      // --- handleRenameEvent (real repo, no git involved -- pure storage migration + check) ---
      writeFileSync(absSmall, "export function delta() {\n  return 4;\n}\n");
      const { recordId: deltaRecordId } = documentationService.writeDoc(repoPath, relSmall, 0, "export function delta() {\n  return 4;\n}\n".length, "Documents delta.");
      const relSmallRenamed = "vscode-extension/src/__syncservice_test_small_renamed__.ts";
      const renameMessages = syncService.handleRenameEvent(repoPath, relSmall, relSmallRenamed);
      const renamedStorage = documentationService.loadStorage(repoPath, relSmallRenamed);
      lines.push(
        `handleRenameEvent: ${renameMessages.length} message(s), record survived migration=${!!renamedStorage.records[deltaRecordId]}`
      );

      // --- checkFileOnDemand: NOT skippable (small, already documented) -> null ---
      const onDemandSmall = syncService.checkFileOnDemand(repoPath, relSmallRenamed);
      lines.push(`checkFileOnDemand (small, documented): ${onDemandSmall === null ? "null (correct, no-op)" : `${onDemandSmall.length} messages (WRONG)`}`);

      // --- checkFileOnDemand: genuinely skippable (>100KB, undocumented) -> real messages ---
      const padding = "// padding\n".repeat(10_000); // well over LARGE_FILE_THRESHOLD_BYTES (100_000)
      writeFileSync(absLarge, `${padding}export function epsilon() {\n  return 5;\n}\n`);
      const onDemandLarge = syncService.checkFileOnDemand(repoPath, relLarge);
      lines.push(
        `checkFileOnDemand (>100KB, undocumented): ${onDemandLarge === null ? "null (WRONG, expected real messages)" : `${onDemandLarge.length} real message(s) (correct)`}`
      );

      // --- Resilience: a fullScan continues past one unparseable file and
      // still checks the rest of the repo; handleFileEvent doesn't crash on
      // a live edit that makes a file unparseable. Also confirms fullScan's
      // OWN skip-large-undocumented path (a third, separate caller of the
      // shared skip logic, alongside the diff loop above and
      // checkFileOnDemand). Uses a dedicated second scratch repo so this
      // cleanly hits the first-ever-sync fullScan branch, isolated from
      // scratchDir's already-established history. ---
      const scratchDir2 = mkdtempSync(join(tmpdir(), "rapid-docs-syncservice-resilience-scratch-"));
      try {
        execFileSync("git", ["init"], { cwd: scratchDir2 });
        execFileSync("git", ["config", "user.email", "test@rapid-docs.local"], { cwd: scratchDir2 });
        execFileSync("git", ["config", "user.name", "rapid-docs test"], { cwd: scratchDir2 });
        writeFileSync(join(scratchDir2, "good.ts"), "export function goodFunc() {\n  return 1;\n}\n");
        writeFileSync(join(scratchDir2, "broken.ts"), "function broken( {{{ not valid syntax at all");
        const largePaddingScan = "// padding\n".repeat(10_000);
        writeFileSync(join(scratchDir2, "large-undocumented.ts"), `${largePaddingScan}export function largeFunc() {\n  return 1;\n}\n`);
        execFileSync("git", ["add", "."], { cwd: scratchDir2 });
        execFileSync("git", ["commit", "-m", "init"], { cwd: scratchDir2 });

        const resilienceReport = syncService.sync(scratchDir2); // first-ever sync -> fullScan
        const goodFlagged = resilienceReport.messages.some((m) => m.relativePath === "good.ts");
        const largeFlaggedInFullScan = resilienceReport.messages.some((m) => m.relativePath === "large-undocumented.ts");
        lines.push(
          `fullScan resilience + skip: good.ts still flagged despite broken.ts present=${goodFlagged} (expected true, fullScan must not abort on the first parse failure), large-undocumented.ts skipped in the bulk pass=${!largeFlaggedInFullScan} (expected true, i.e. NOT flagged)`
        );

        let liveEditThrew = false;
        let liveEditMessages: unknown[] = [];
        try {
          liveEditMessages = syncService.handleFileEvent(scratchDir2, "broken.ts");
        } catch {
          liveEditThrew = true;
        }
        lines.push(`handleFileEvent on an unparseable live file: threw=${liveEditThrew} (expected false), returned ${liveEditMessages.length} message(s) without crashing`);
      } finally {
        try {
          rmSync(scratchDir2, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
        } catch {
          /* non-fatal, matches the earlier Windows-EPERM lesson */
        }
      }

      vscode.window.showInformationMessage("rapid-docs: SyncService section test finished, see proof file for full results.");
    } catch (err) {
      lines.push(`ERROR: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      vscode.window.showErrorMessage("rapid-docs: SyncService test failed partway, see proof file for what succeeded before that.");
    } finally {
      for (const abs of [absSmall, absLarge]) {
        try {
          if (existsSync(abs)) unlinkSync(abs);
        } catch {
          /* non-fatal */
        }
      }
      try {
        rmSync(scratchDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch {
        /* non-fatal, matches the earlier GitService/Windows-EPERM lesson */
      }
      writeFileSync(join(tmpdir(), "rapid-docs-syncservice-proof.txt"), `${new Date().toISOString()}\n${lines.join("\n")}\n`);
    }
  });
  context.subscriptions.push(disposable);
}
