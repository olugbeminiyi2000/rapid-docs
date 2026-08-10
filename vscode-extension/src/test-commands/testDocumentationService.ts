import * as vscode from "vscode";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { DocumentationService } from "../types";

// Section 4 (DocumentationService), the biggest section: the 9 methods never
// exercised by writeDoc/findDocumentedNodes/deleteRecord alone, plus 3 real
// gaps found later via a cross-reference against the original Jest suite
// (duplicate-highlight rejection, a looser-than-exact selection match, and
// deleteRecord throwing for a nonexistent record). Uses disposable scratch
// files inside the real workspace (needed since every one of these methods
// reads real file content off disk), all removed in a finally block
// regardless of where the test stops.
export function registerTestDocumentationService(context: vscode.ExtensionContext, documentationService: DocumentationService): void {
  const disposable = vscode.commands.registerCommand("rapidDocs.testDocumentationService", () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showWarningMessage("rapid-docs: no workspace folder open.");
      return;
    }
    const repoPath = folder.uri.fsPath;
    const lines: string[] = [];
    const relA = "vscode-extension/src/__docservice_test_a__.ts";
    const relARenamed = "vscode-extension/src/__docservice_test_a_renamed__.ts";
    const relB = "vscode-extension/src/__docservice_test_b__.ts";
    const relC = "vscode-extension/src/__docservice_test_c__.ts";
    const absA = join(repoPath, relA);
    const absB = join(repoPath, relB);
    const absC = join(repoPath, relC);

    const relBroken = "vscode-extension/src/__docservice_test_broken__.ts";
    const absBroken = join(repoPath, relBroken);

    const relD = "vscode-extension/src/__docservice_test_d__.ts";
    const absD = join(repoPath, relD);

    try {
      // --- writeDoc + findRecordForSelection (found / not found) ---
      const originalContent = "function calculate(a, b) {\n  const sum = a + b;\n  return sum;\n}\n";
      writeFileSync(absA, originalContent);
      const { recordId: recordId1 } = documentationService.writeDoc(repoPath, relA, 0, originalContent.length, "Adds two numbers.");
      lines.push(`writeDoc: wrote record ${recordId1}`);

      // --- writeDoc: refuses the exact same highlight twice -- a real
      // duplicate-prevention guard, never exercised before this. ---
      let duplicateRejected = false;
      try {
        documentationService.writeDoc(repoPath, relA, 0, originalContent.length, "Duplicate attempt.");
      } catch {
        duplicateRejected = true;
      }
      lines.push(`writeDoc duplicate rejection (same file, same exact selection, twice): threw=${duplicateRejected} (expected true)`);

      // --- findRecordForSelection: finds a record even when the selection
      // is LOOSER (wider) than the exact node boundary that was documented
      // -- the actual real-world case, since a human drag-selection almost
      // never lands exactly on an AST node's precise start/end. Uses a
      // separate file whose documented span deliberately excludes trailing
      // blank lines, then queries with a selection that includes them. ---
      const functionOnly = "function loose() {\n  return 42;\n}\n";
      const contentD = functionOnly + "\n\n";
      writeFileSync(absD, contentD);
      const { recordId: recordIdD } = documentationService.writeDoc(repoPath, relD, 0, functionOnly.length, "Loose selection test.");
      const looseMatch = documentationService.findRecordForSelection(repoPath, relD, 0, contentD.length);
      lines.push(
        `findRecordForSelection (selection wider than the exact documented node span): ${looseMatch ? `found ${looseMatch.recordId}, matches=${looseMatch.recordId === recordIdD}` : "null (WRONG, expected a match despite the looser boundary)"}`
      );

      // --- deleteRecord: throws for a nonexistent record id -- every prior
      // test only exercised the success path. ---
      let deleteNonexistentThrew = false;
      try {
        documentationService.deleteRecord(repoPath, relD, "nonexistent-record-id-xyz");
      } catch {
        deleteNonexistentThrew = true;
      }
      lines.push(`deleteRecord on a nonexistent record id: threw=${deleteNonexistentThrew} (expected true)`);

      // --- canParseFile: real parseable file (true) and a genuinely broken one (false) ---
      const canParseGood = documentationService.canParseFile(repoPath, relA);
      writeFileSync(absBroken, "function broken( {{{ this is not valid syntax at all");
      const canParseBad = documentationService.canParseFile(repoPath, relBroken);
      lines.push(`canParseFile: real parseable file=${canParseGood} (expected true), genuinely broken file=${canParseBad} (expected false)`);

      // --- listDocumentedFileIds: confirm it includes the file we just documented ---
      const documentedIdsAfterA = documentationService.listDocumentedFileIds(repoPath);
      lines.push(`listDocumentedFileIds (after documenting A only): includes relA=${documentedIdsAfterA.includes(relA)}`);

      const foundMatch = documentationService.findRecordForSelection(repoPath, relA, 0, originalContent.length);
      lines.push(`findRecordForSelection (exact match): ${foundMatch ? `found ${foundMatch.recordId}, matches written record=${foundMatch.recordId === recordId1}` : "null (WRONG, expected a match)"}`);

      const noMatch = documentationService.findRecordForSelection(repoPath, relA, 0, 1);
      lines.push(`findRecordForSelection (trivial 1-char selection): ${noMatch === null ? "null (correct, no record)" : "found something (WRONG)"}`);

      // --- drift a PART of the function, keeping the "const sum = a + b;" statement untouched ---
      const driftedContent = "function calculate(a, b) {\n  const sum = a + b;\n  return sum * 2;\n}\n";
      writeFileSync(absA, driftedContent);
      const report = documentationService.checkFile(repoPath, relA);
      const drift = report.driftResults.find((d) => d.recordId === recordId1);
      lines.push(`checkFile after drift: status=${drift?.status} (expected "partially_stale"), matchingRanges=${drift?.matchingRanges.length ?? 0}`);

      // --- findStaleRecordForSelection, using the REAL matchingRanges checkFile just reported, not a predicted range ---
      let recordId2: string | null = null;
      if (drift && drift.status === "partially_stale" && drift.matchingRanges.length > 0) {
        const anchor = drift.matchingRanges[0];
        const staleMatch = documentationService.findStaleRecordForSelection(repoPath, relA, anchor.start, anchor.end);
        lines.push(`findStaleRecordForSelection (real anchor range): ${staleMatch ? `found ${staleMatch.recordId}, matches=${staleMatch.recordId === recordId1}` : "null (WRONG)"}`);

        // --- updateDriftedDoc: resolve the drift in one step ---
        const updated = documentationService.updateDriftedDoc(repoPath, relA, recordId1, 0, driftedContent.length, "Adds two numbers, doubled.");
        const newRecordId: string = updated.recordId;
        recordId2 = newRecordId;
        const storageAfterUpdate = documentationService.loadStorage(repoPath, relA);
        lines.push(
          `updateDriftedDoc: new record ${newRecordId}, old record ${recordId1} gone=${!storageAfterUpdate.records[recordId1]}, new record present=${!!storageAfterUpdate.records[newRecordId]}`
        );
      } else {
        lines.push(`SKIPPED findStaleRecordForSelection/updateDriftedDoc: drift didn't come back as expected, see status above.`);
      }

      // --- editDocText ---
      if (recordId2) {
        documentationService.editDocText(repoPath, relA, recordId2, "Adds two numbers, doubled. Edited.");
        const storageAfterEdit = documentationService.loadStorage(repoPath, relA);
        lines.push(`editDocText: docText now = "${storageAfterEdit.records[recordId2]?.docText}"`);
      }

      // --- renameFile (storage-only migration) ---
      documentationService.renameFile(repoPath, relA, relARenamed);
      const oldStorageGone = !existsSync(documentationService.storagePathFor(repoPath, relA));
      const newStorageExists = existsSync(documentationService.storagePathFor(repoPath, relARenamed));
      lines.push(`renameFile: old storage gone=${oldStorageGone}, new storage exists=${newStorageExists}`);

      // --- handleDeletedFile (file A, now at its renamed path) -> produces archive entry #1 ---
      const deleteMessagesA = documentationService.handleDeletedFile(repoPath, relARenamed);
      lines.push(`handleDeletedFile (A): ${deleteMessagesA.length} message(s) returned, storage removed=${!existsSync(documentationService.storagePathFor(repoPath, relARenamed))}`);

      // --- a second, independent documented-then-deleted file -> archive entry #2 ---
      const contentB = "const greeting = \"hi\";\n";
      writeFileSync(absB, contentB);
      documentationService.writeDoc(repoPath, relB, 0, contentB.length, "A greeting constant.");

      // --- listDocumentedFileIds again: confirms it tracks REAL current state, not a stale snapshot -- A is gone (archived above), B is now the one documented ---
      const documentedIdsAfterB = documentationService.listDocumentedFileIds(repoPath);
      lines.push(
        `listDocumentedFileIds (after A archived, B documented): includes relB=${documentedIdsAfterB.includes(relB)}, no longer includes relARenamed=${!documentedIdsAfterB.includes(relARenamed)}`
      );

      const deleteMessagesB = documentationService.handleDeletedFile(repoPath, relB);
      lines.push(`handleDeletedFile (B): ${deleteMessagesB.length} message(s) returned`);

      // --- loadArchive: confirm both real entries are there ---
      const archiveAfterBoth = documentationService.loadArchive(repoPath);
      const entryA = archiveAfterBoth.find((e) => e.originalFileId === relARenamed);
      const entryB = archiveAfterBoth.find((e) => e.originalFileId === relB);
      lines.push(`loadArchive: ${archiveAfterBoth.length} total entries, entry for A present=${!!entryA}, entry for B present=${!!entryB}`);

      // --- attachArchivedRecord: reattach A's archived text onto fresh code in file C ---
      if (entryA) {
        const contentC = "function unrelated() {\n  return 1;\n}\n";
        writeFileSync(absC, contentC);
        const attached = documentationService.attachArchivedRecord(repoPath, entryA.id, relC, 0, contentC.length);
        const archiveAfterAttach = documentationService.loadArchive(repoPath);
        lines.push(
          `attachArchivedRecord: new record ${attached.recordId} with docText "${attached.record.docText}", archive shrank ${archiveAfterBoth.length} -> ${archiveAfterAttach.length}`
        );
      }

      // --- discardArchivedRecord: permanently discard B's entry ---
      if (entryB) {
        documentationService.discardArchivedRecord(repoPath, entryB.id);
        const archiveAfterDiscard = documentationService.loadArchive(repoPath);
        const stillThere = archiveAfterDiscard.some((e) => e.id === entryB.id);
        lines.push(`discardArchivedRecord: entry still present afterward=${stillThere} (expected false)`);
      }

      vscode.window.showInformationMessage("rapid-docs: DocumentationService section test finished, see proof file for full results.");
    } catch (err) {
      lines.push(`ERROR: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      vscode.window.showErrorMessage("rapid-docs: DocumentationService test failed partway, see proof file for what succeeded before that.");
    } finally {
      for (const abs of [absA, absB, absC, absBroken, absD]) {
        try {
          if (existsSync(abs)) unlinkSync(abs);
        } catch {
          /* non-fatal, matches the GitService lesson: cleanup failure must never mask real evidence */
        }
      }
      writeFileSync(join(tmpdir(), "rapid-docs-documentationservice-proof.txt"), `${new Date().toISOString()}\n${lines.join("\n")}\n`);
    }
  });
  context.subscriptions.push(disposable);
}
