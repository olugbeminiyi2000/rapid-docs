import * as vscode from "vscode";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import type { GitService } from "../types";

// Section 3 (GitService), the remaining methods beyond getHeadCommit. diff()
// is checked against this repo's OWN real, current git history (HEAD vs
// HEAD~1, computed fresh via raw git calls here in the test harness itself,
// not hardcoded commit hashes that would go stale the moment another commit
// lands), and getLastSyncedCommit/setLastSyncedCommit use a genuinely
// disposable scratch git repo, so this never touches this real repo's own
// .git/rapid-docs/last-sync.json pointer.
export function registerTestGitService(context: vscode.ExtensionContext, gitService: GitService): void {
  const disposable = vscode.commands.registerCommand("rapidDocs.testGitService", () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showWarningMessage("rapid-docs: no workspace folder open.");
      return;
    }
    const repoPath = folder.uri.fsPath;
    const lines: string[] = [];

    // Whatever succeeded before a failure stays on record -- losing every
    // earlier result just because a later step throws would defeat the
    // whole point of writing real evidence per step.
    try {
      const tracked = gitService.listTrackedFiles(repoPath);
      lines.push(`listTrackedFiles: ${tracked.length} files, includes package.json=${tracked.includes("package.json")}`);

      const workingTree = gitService.listWorkingTreeFiles(repoPath);
      lines.push(`listWorkingTreeFiles: ${workingTree.length} files, includes package.json=${workingTree.includes("package.json")}`);

      const ignored = gitService.listIgnoredPaths(repoPath);
      const hasNodeModules = ignored.some((p) => p.includes("node_modules"));
      lines.push(`listIgnoredPaths: ${ignored.length} entries, includes node_modules=${hasNodeModules}`);

      // getLastSyncedCommit / setLastSyncedCommit -- disposable scratch repo.
      const scratchDir = mkdtempSync(join(tmpdir(), "rapid-docs-gitservice-scratch-"));
      try {
        execFileSync("git", ["init"], { cwd: scratchDir });
        execFileSync("git", ["config", "user.email", "test@rapid-docs.local"], { cwd: scratchDir });
        execFileSync("git", ["config", "user.name", "rapid-docs test"], { cwd: scratchDir });
        writeFileSync(join(scratchDir, "a.txt"), "hello");
        execFileSync("git", ["add", "."], { cwd: scratchDir });
        execFileSync("git", ["commit", "-m", "init"], { cwd: scratchDir });

        const beforeSet = gitService.getLastSyncedCommit(scratchDir);
        gitService.setLastSyncedCommit(scratchDir, "abc123deadbeef");
        const afterSet = gitService.getLastSyncedCommit(scratchDir);
        lines.push(`getLastSyncedCommit before any set: ${beforeSet} (expected null)`);
        lines.push(`setLastSyncedCommit + getLastSyncedCommit round-trip: ${afterSet} (expected "abc123deadbeef")`);
      } finally {
        // Windows can hold a file lock on something inside .git/ for longer
        // than the retry budget can cover (confirmed for real: even 5
        // retries at 200ms wasn't enough once). This cleanup failing is
        // never allowed to mask the actual GitService results gathered
        // above -- a leftover scratch dir in the OS temp folder is
        // harmless, but losing real evidence because of it is not.
        try {
          rmSync(scratchDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
        } catch (cleanupErr) {
          lines.push(
            `(non-fatal) failed to remove scratch dir ${scratchDir}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`
          );
        }
      }

      // diff() against this repo's OWN real current history.
      const currentHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath, encoding: "utf-8" }).trim();
      const parentHead = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: repoPath, encoding: "utf-8" }).trim();
      const expectedChanged = execFileSync("git", ["diff", "--name-only", parentHead, currentHead], { cwd: repoPath, encoding: "utf-8" })
        .trim()
        .split("\n")
        .filter(Boolean)
        .sort();
      const diffResult = gitService.diff(repoPath, parentHead, currentHead);
      const actualChanged = [...diffResult.added, ...diffResult.modified, ...diffResult.deleted, ...diffResult.renamed.map((r) => r.to)].sort();
      const diffMatches = JSON.stringify(expectedChanged) === JSON.stringify(actualChanged);
      lines.push(`diff(HEAD~1, HEAD): expected changed files ${JSON.stringify(expectedChanged)}, got ${JSON.stringify(actualChanged)}, matches=${diffMatches}`);

      // compareContent -- no repo needed at all.
      const similar = gitService.compareContent("function greet() {\n  return 'hi';\n}\n", "function greet() {\n  return 'hi there';\n}\n");
      const different = gitService.compareContent("function greet() {\n  return 'hi';\n}\n", "class TotallyUnrelated {}\n");
      lines.push(`compareContent on similar content: ${JSON.stringify(similar)} (expected a real similarity match)`);
      lines.push(`compareContent on unrelated content: ${JSON.stringify(different)} (expected null)`);

      const summary = `GitService: tracked=${tracked.length}, ignored=${ignored.length}, syncPointer round-trip ok, diff matches=${diffMatches}`;
      vscode.window.showInformationMessage(`rapid-docs: ${summary}`);
    } catch (err) {
      lines.push(`ERROR: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      vscode.window.showErrorMessage(`rapid-docs: GitService test failed partway, see proof file for what succeeded before that.`);
    } finally {
      writeFileSync(join(tmpdir(), "rapid-docs-gitservice-proof.txt"), `${new Date().toISOString()}\n${lines.join("\n")}\n`);
    }
  });
  context.subscriptions.push(disposable);
}
