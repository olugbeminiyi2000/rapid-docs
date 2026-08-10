import * as vscode from "vscode";
import { writeFileSync, mkdtempSync, rmSync, unlinkSync, renameSync, mkdirSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import type { LiveWatchService, RapidDocsMessage } from "../types";

// Section 6 (LiveWatchService): start()/one event/stop() were already proven
// in Section 1. What's left is the rename-correlation window (add+unlink
// paired within it = a rename, not two separate events), genuine
// rapid-succession changes to different files staying separate, an unlink
// with no matching add correctly falling through as a real delete once the
// window elapses, the "someone else's documentation arrived via git pull"
// storage-only-change path, and (found later via the Jest-suite
// cross-reference) a gitignored directory's contents never being watched at
// all. Real async timing is involved here (chokidar's own event delivery,
// the correlation window's setTimeout), unlike every synchronous method
// tested in Sections 2-5.
export function registerTestLiveWatchService(context: vscode.ExtensionContext, liveWatchService: LiveWatchService): void {
  const disposable = vscode.commands.registerCommand("rapidDocs.testLiveWatchSection", async () => {
    const lines: string[] = [];
    const scratchDir = mkdtempSync(join(tmpdir(), "rapid-docs-livewatch-section-scratch-"));
    // 500ms matches the REAL production default (DEFAULT_CORRELATION_WINDOW_MS
    // in live-watch.service.ts) rather than an artificially tight value --
    // found for real that 150ms left too little headroom against genuine
    // Windows unlink-detection latency (measured ~109ms on this machine),
    // producing a false failure that wasn't a real bug, just an unrealistic
    // test window undershooting what the actual, shipped default already covers.
    const correlationWindowMs = 500;

    type Collected = { relativePaths: string[]; messageCount: number; at: number };
    const collected: Collected[] = [];
    const listener = (relativePaths: string[], messages: RapidDocsMessage[]) => {
      collected.push({ relativePaths, messageCount: messages.length, at: Date.now() });
    };

    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    try {
      // Reset to a clean slate -- liveWatchService is the SAME shared
      // instance testLiveWatch (Section 1) may already have started once
      // this session, on a different repo entirely.
      await liveWatchService.stop();

      execFileSync("git", ["init"], { cwd: scratchDir });
      execFileSync("git", ["config", "user.email", "test@rapid-docs.local"], { cwd: scratchDir });
      execFileSync("git", ["config", "user.name", "rapid-docs test"], { cwd: scratchDir });
      const contentX = "export function xFunc() {\n  return \"x\";\n}\n";
      const contentY = "export function yFunc() {\n  return \"y\";\n}\n";
      const contentW = "export function wFunc() {\n  return \"w\";\n}\n";
      const contentP1 = "export function p1Func() {\n  return \"p1\";\n}\n";
      const contentP2 = "export function p2Func() {\n  return \"p2\";\n}\n";
      writeFileSync(join(scratchDir, "x.ts"), contentX);
      writeFileSync(join(scratchDir, "y.ts"), contentY);
      writeFileSync(join(scratchDir, "w.ts"), contentW);
      // p1/p2 exist BEFORE start() specifically so their content is cache-primed --
      // required for the unlink side of each rename pair below to have real
      // cached content to correlate against (handleUnlink bails out immediately,
      // uncorrelated, if contentCache has nothing for that exact path).
      writeFileSync(join(scratchDir, "p1.ts"), contentP1);
      writeFileSync(join(scratchDir, "p2.ts"), contentP2);
      // .gitignore must exist and be committed BEFORE start() -- the watch
      // set itself is built once at startup from the real ignored-paths
      // list, so this has to be real, known-ignored state going in, not
      // something added after the watcher is already running.
      mkdirSync(join(scratchDir, "ignored-dir"), { recursive: true });
      writeFileSync(join(scratchDir, ".gitignore"), "ignored-dir/\n");
      execFileSync("git", ["add", "."], { cwd: scratchDir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: scratchDir });

      liveWatchService.on("messages", listener);
      await liveWatchService.start(scratchDir, correlationWindowMs);
      lines.push(`start() with a ${correlationWindowMs}ms correlation window: ok`);

      // --- Test E: a gitignored directory's contents are never watched at
      // all, not just filtered after the fact -- confirmed by writing a
      // brand-new file inside it AFTER start() and getting zero events,
      // even once the full correlation window has elapsed. Real,
      // previously-fixed-bug territory (the whole gitignore-watching
      // performance investigation earlier in the project), completely
      // unverified in the extension until now. ---
      writeFileSync(join(scratchDir, "ignored-dir", "secret.ts"), "export function secretFunc() {\n  return \"secret\";\n}\n");
      await wait(correlationWindowMs * 4);
      const ignoredDirEvent = collected.find((e) => e.relativePaths.some((p) => p.includes("ignored-dir")));
      lines.push(`Gitignored directory contents never watched: wrote a new file inside ignored-dir/ after start(), event fired=${!!ignoredDirEvent} (expected false -- must be excluded from the watch set itself, not filtered after the fact)`);
      collected.length = 0;

      // --- Test A1: rename correlation, UNLINK arrives first -- exercises
      // handleAdd's own pendingUnlinks-matching loop specifically. A single
      // real OS renameSync only ever exercises whichever order chokidar/the
      // OS happens to report, so the two directions are triggered explicitly
      // and separately here instead, via a deliberate small gap between the
      // two raw fs operations to bias which one chokidar sees first. ---
      unlinkSync(join(scratchDir, "p1.ts"));
      await wait(60); // comfortably inside the 150ms correlation window
      writeFileSync(join(scratchDir, "p1-renamed.ts"), contentP1);
      await wait(correlationWindowMs * 4);
      const p1Events = collected.filter((e) => e.relativePaths.includes("p1.ts") || e.relativePaths.includes("p1-renamed.ts"));
      const p1Correlated = p1Events.some((e) => e.relativePaths.length === 2 && e.relativePaths.includes("p1.ts") && e.relativePaths.includes("p1-renamed.ts"));
      lines.push(`Rename correlation, unlink-arrives-first (p1.ts -> p1-renamed.ts, exercises handleAdd's matching loop): ${p1Events.length} relevant event(s), correlated=${p1Correlated}`);
      collected.length = 0;

      // --- Test A2: rename correlation, ADD arrives first -- exercises
      // handleUnlink's own pendingAdds-matching loop specifically. ---
      const p2StartTime = Date.now();
      writeFileSync(join(scratchDir, "p2-renamed.ts"), contentP2);
      await wait(60);
      unlinkSync(join(scratchDir, "p2.ts"));
      await wait(correlationWindowMs * 4);
      const p2Events = collected.filter((e) => e.relativePaths.includes("p2.ts") || e.relativePaths.includes("p2-renamed.ts"));
      const p2Correlated = p2Events.some((e) => e.relativePaths.length === 2 && e.relativePaths.includes("p2.ts") && e.relativePaths.includes("p2-renamed.ts"));
      lines.push(`Rename correlation, add-arrives-first (p2.ts -> p2-renamed.ts, exercises handleUnlink's matching loop): ${p2Events.length} relevant event(s), correlated=${p2Correlated}`);
      if (!p2Correlated) {
        lines.push(
          `  DIAGNOSTIC: ${p2Events.map((e) => `[+${e.at - p2StartTime}ms] paths=${JSON.stringify(e.relativePaths)}`).join(" | ")}`
        );
      }
      collected.length = 0;

      // --- Also confirm a real OS rename (whichever order the OS actually
      // uses) still correlates end to end, as a real-world sanity check on
      // top of the two controlled directions above. ---
      renameSync(join(scratchDir, "x.ts"), join(scratchDir, "x-renamed.ts"));
      await wait(correlationWindowMs * 4);
      const renameEvents = collected.filter((e) => e.relativePaths.includes("x.ts") || e.relativePaths.includes("x-renamed.ts"));
      const correlated = renameEvents.some((e) => e.relativePaths.length === 2 && e.relativePaths.includes("x.ts") && e.relativePaths.includes("x-renamed.ts"));
      lines.push(`Real OS rename, whichever order actually fires (x.ts -> x-renamed.ts): ${renameEvents.length} relevant event(s), correlated=${correlated}`);
      collected.length = 0;

      // --- Test B: unlink-only, no matching add -> falls through as a real delete once the window elapses ---
      unlinkSync(join(scratchDir, "y.ts"));
      await wait(correlationWindowMs * 4);
      const unlinkEvents = collected.filter((e) => e.relativePaths.includes("y.ts"));
      const singlePathUnlink = unlinkEvents.length === 1 && unlinkEvents[0].relativePaths.length === 1;
      lines.push(`Unlink-only (y.ts deleted, no pairing add): ${unlinkEvents.length} event(s), correctly a single, un-paired path=${singlePathUnlink}`);
      collected.length = 0;

      // --- Test C: rapid, near-simultaneous changes to two DIFFERENT files stay separate ---
      writeFileSync(join(scratchDir, "x-renamed.ts"), contentX + "// touched\n");
      writeFileSync(join(scratchDir, "w.ts"), contentW + "// touched\n");
      await wait(correlationWindowMs * 4);
      const xEvent = collected.find((e) => e.relativePaths.length === 1 && e.relativePaths[0] === "x-renamed.ts");
      const wEvent = collected.find((e) => e.relativePaths.length === 1 && e.relativePaths[0] === "w.ts");
      lines.push(`Rapid changes to 2 different files: x-renamed.ts got its own event=${!!xEvent}, w.ts got its own event=${!!wEvent}, no cross-contamination=${collected.length === 2}`);
      collected.length = 0;

      // --- Test D1: a .rapid-docs storage file APPEARING (add) -> rechecks the SOURCE file, not the storage path ---
      const storageDir = join(scratchDir, ".rapid-docs");
      mkdirSync(storageDir, { recursive: true });
      const storageFile = join(storageDir, "w.ts.json");
      writeFileSync(storageFile, JSON.stringify({ fileId: "w.ts", records: {} }, null, 2));
      await wait(correlationWindowMs * 4);
      const derivedAddEvent = collected.find((e) => e.relativePaths.includes("w.ts"));
      lines.push(`Storage-only ADD (.rapid-docs/w.ts.json created): rechecked the real source file w.ts, not the storage path=${!!derivedAddEvent}`);
      collected.length = 0;

      // --- Test D2: that SAME storage file being MODIFIED (change), the derive-check inside handleChange specifically ---
      writeFileSync(storageFile, JSON.stringify({ fileId: "w.ts", records: { dummy: true } }, null, 2));
      await wait(correlationWindowMs * 4);
      const derivedChangeEvent = collected.find((e) => e.relativePaths.includes("w.ts"));
      lines.push(`Storage-only CHANGE (.rapid-docs/w.ts.json modified): rechecked the real source file w.ts=${!!derivedChangeEvent}`);
      collected.length = 0;

      // --- Test D3: that SAME storage file being DELETED (unlink), the derive-check inside handleUnlink specifically ---
      unlinkSync(storageFile);
      await wait(correlationWindowMs * 4);
      const derivedUnlinkEvent = collected.find((e) => e.relativePaths.includes("w.ts"));
      lines.push(`Storage-only UNLINK (.rapid-docs/w.ts.json deleted): rechecked the real source file w.ts=${!!derivedUnlinkEvent}`);

      vscode.window.showInformationMessage("rapid-docs: LiveWatchService section test finished, see proof file for full results.");
    } catch (err) {
      lines.push(`ERROR: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      vscode.window.showErrorMessage("rapid-docs: LiveWatchService test failed partway, see proof file for what succeeded before that.");
    } finally {
      liveWatchService.off("messages", listener);
      try {
        await liveWatchService.stop();
      } catch {
        /* non-fatal */
      }
      try {
        rmSync(scratchDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch {
        /* non-fatal, matches the earlier Windows-EPERM lesson */
      }
      writeFileSync(join(tmpdir(), "rapid-docs-livewatch-section-proof.txt"), `${new Date().toISOString()}\n${lines.join("\n")}\n`);
    }
  });
  context.subscriptions.push(disposable);
}
