import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AstService } from "../ast/ast.service.js";
import { DocumentationService } from "../ast/documentation.service.js";
import { GitService } from "../git/git.service.js";
import { LARGE_FILE_THRESHOLD_BYTES, MINIFIED_MIN_SIZE_BYTES, SyncService } from "./sync.service.js";

describe("SyncService", () => {
  let astService: AstService;
  let documentationService: DocumentationService;
  let gitService: GitService;
  let syncService: SyncService;
  let repoPath: string;

  function git(...args: string[]): string {
    return execFileSync("git", args, { cwd: repoPath, encoding: "utf-8" });
  }

  function commitFile(fileName: string, content: string, message: string): void {
    writeFileSync(join(repoPath, fileName), content);
    git("add", fileName);
    git("commit", "-qm", message);
  }

  const undocumentedSource = `function greet(name) {\n  console.log("hi " + name);\n}\n`;
  const documentedSource = `function greet(name) {\n  console.log("hi " + name);\n}\n`;

  beforeEach(() => {
    astService = new AstService();
    documentationService = new DocumentationService(astService);
    gitService = new GitService();
    syncService = new SyncService(gitService, documentationService);

    repoPath = mkdtempSync(join(tmpdir(), "sync-service-test-"));
    git("init", "-q");
    git("config", "user.email", "test@test.com");
    git("config", "user.name", "test");
    git("config", "core.autocrlf", "false");
  });

  afterEach(() => {
    // Storage now lives inside repoPath (.rapid-docs/), so removing repoPath
    // removes everything -- no separate storage cleanup needed anymore.
    rmSync(repoPath, { recursive: true, force: true });
  });

  // Real bug found via manual end-to-end testing: pointing rapid-docs at a
  // real, freshly-created git repo with zero commits (a fresh `git init`, or
  // a brand-new empty GitHub repo before the first commit) crashed the whole
  // app, because getHeadCommit() used to throw rather than return null.
  describe("a real repo with zero commits yet", () => {
    it("does not throw, and reports nothing to sync", () => {
      expect(() => syncService.sync(repoPath)).not.toThrow();
      expect(syncService.sync(repoPath)).toEqual({ messages: [] });
    });

    it("does not record a sync pointer, so the normal first-time full scan still runs once the first commit exists", () => {
      syncService.sync(repoPath);
      expect(gitService.getLastSyncedCommit(repoPath)).toBeNull();

      commitFile("undocumented.js", undocumentedSource, "initial");
      const report = syncService.sync(repoPath);

      expect(report.messages.some((m) => m.severity === "info")).toBe(true);
      expect(gitService.getLastSyncedCommit(repoPath)).toBe(gitService.getHeadCommit(repoPath));
    });
  });

  describe("first run (no stored sync pointer)", () => {
    it("does a full scan, flagging undocumented nodes across every tracked source file", () => {
      commitFile("undocumented.js", undocumentedSource, "initial");

      const report = syncService.sync(repoPath);

      expect(report.messages.some((m) => m.severity === "info")).toBe(true);
      expect(gitService.getLastSyncedCommit(repoPath)).toBe(gitService.getHeadCommit(repoPath));
    });

    it("skips non-source files during the full scan", () => {
      commitFile("README.md", "# hello\n", "initial");

      const report = syncService.sync(repoPath);

      expect(report.messages).toEqual([]);
    });
  });

  describe("no changes since last sync", () => {
    it("returns no messages and does not touch the pointer", () => {
      commitFile("a.js", "const x = 1;\n", "initial");
      syncService.sync(repoPath);
      const pointerAfterFirstSync = gitService.getLastSyncedCommit(repoPath);

      const second = syncService.sync(repoPath);

      expect(second.messages).toEqual([]);
      expect(gitService.getLastSyncedCommit(repoPath)).toBe(pointerAfterFirstSync);
    });
  });

  describe("modified files", () => {
    it("flags drift once a documented file's content changes", () => {
      commitFile("modified.js", documentedSource, "initial");
      documentationService.writeDoc(repoPath, "modified.js", 0, documentedSource.length, "greets someone");
      syncService.sync(repoPath); // establish baseline

      commitFile("modified.js", `function greet(name) {\n  return "hi " + name;\n}\n`, "modify");
      const report = syncService.sync(repoPath);

      const warning = report.messages.find((m) => m.severity === "warning" || m.severity === "error");
      expect(warning).toBeDefined();
    });
  });

  describe("renamed files", () => {
    it("migrates the DocRecord to the new path and checks it there", () => {
      commitFile("old-name.js", documentedSource, "initial");
      documentationService.writeDoc(repoPath, "old-name.js", 0, documentedSource.length, "greets someone");
      syncService.sync(repoPath); // establish baseline

      git("mv", "old-name.js", "new-name.js");
      git("commit", "-qm", "rename");
      syncService.sync(repoPath);

      expect(existsSync(documentationService.storagePathFor(repoPath, "old-name.js"))).toBe(false);
      expect(existsSync(documentationService.storagePathFor(repoPath, "new-name.js"))).toBe(true);
    });

    it("does not throw when a renamed file was never documented in the first place", () => {
      commitFile("never-documented.js", undocumentedSource, "initial");
      syncService.sync(repoPath); // establish baseline, no writeDoc call at all

      git("mv", "never-documented.js", "renamed-never-documented.js");
      git("commit", "-qm", "rename undocumented file");

      expect(() => syncService.sync(repoPath)).not.toThrow();
    });
  });

  describe("deleted files", () => {
    it("surfaces the old docText and removes the storage", () => {
      commitFile("deleted.js", documentedSource, "initial");
      documentationService.writeDoc(repoPath, "deleted.js", 0, documentedSource.length, "greets someone");
      syncService.sync(repoPath); // establish baseline

      git("rm", "-q", "deleted.js");
      git("commit", "-qm", "remove file");
      const report = syncService.sync(repoPath);

      const deletionMessage = report.messages.find((m) => m.text.includes("greets someone"));
      expect(deletionMessage).toBeDefined();
      expect(deletionMessage?.severity).toBe("warning");
      expect(existsSync(documentationService.storagePathFor(repoPath, "deleted.js"))).toBe(false);
    });
  });

  describe("non-source files", () => {
    it("does not attempt to parse a modified README", () => {
      commitFile("README.md", "# hello\n", "initial");
      syncService.sync(repoPath); // establish baseline

      commitFile("README.md", "# hello world\n", "modify readme");

      const report = syncService.sync(repoPath);

      expect(report.messages).toEqual([]);
    });
  });

  describe("a single sync spanning multiple categories", () => {
    it("handles an added, a modified, and a deleted file together", () => {
      commitFile("a.js", "const a = 1;\n", "initial a");
      commitFile("b.js", "const b = 2;\n", "initial b");
      syncService.sync(repoPath); // baseline

      commitFile("a.js", "const a = 100;\n", "modify a");
      commitFile("c.js", "const c = 3;\n", "add c");
      git("rm", "-q", "b.js");
      git("commit", "-qm", "delete b");

      const report = syncService.sync(repoPath);

      expect(report.messages.length).toBeGreaterThan(0);
      expect(gitService.getLastSyncedCommit(repoPath)).toBe(gitService.getHeadCommit(repoPath));
    });
  });

  describe("handleFileEvent (the 'live', uncommitted path)", () => {
    it("proves the real crash this fixes: checkFile itself throws on a missing path", () => {
      expect(() => documentationService.checkFile(repoPath, "does-not-exist.js")).toThrow();
    });

    it("routes a deleted, previously-documented file to the deletion handler instead of crashing", () => {
      writeFileSync(join(repoPath, "documented.js"), documentedSource);
      documentationService.writeDoc(repoPath, "documented.js", 0, documentedSource.length, "greets someone");

      // Simulate an uncommitted, live deletion: the file just vanishes from disk,
      // with no git operation involved at all.
      unlinkSync(join(repoPath, "documented.js"));

      let messages: ReturnType<typeof syncService.handleFileEvent> = [];
      expect(() => {
        messages = syncService.handleFileEvent(repoPath, "documented.js");
      }).not.toThrow();

      expect(messages.some((m) => m.text.includes("greets someone"))).toBe(true);
      expect(existsSync(documentationService.storagePathFor(repoPath, "documented.js"))).toBe(false);
    });

    it("routes an existing, modified file through checkFile normally", () => {
      writeFileSync(join(repoPath, "modified.js"), documentedSource);
      documentationService.writeDoc(repoPath, "modified.js", 0, documentedSource.length, "greets someone");

      // Uncommitted edit -- just changes on disk, nothing added or committed.
      writeFileSync(join(repoPath, "modified.js"), `function greet(name) {\n  return "hi " + name;\n}\n`);

      const messages = syncService.handleFileEvent(repoPath, "modified.js");

      expect(messages.some((m) => m.severity === "warning" || m.severity === "error")).toBe(true);
    });

    it("routes a brand new, never-documented file through checkFile normally", () => {
      writeFileSync(join(repoPath, "undocumented.js"), undocumentedSource);

      const messages = syncService.handleFileEvent(repoPath, "undocumented.js");

      expect(messages.some((m) => m.severity === "info")).toBe(true);
    });
  });

  describe("reconcile (catches up on uncommitted changes made while nothing was watching)", () => {
    it("catches a brand new file that was never even staged", () => {
      writeFileSync(join(repoPath, "untracked-new.js"), undocumentedSource);
      // Deliberately no git add/commit at all.

      const report = syncService.reconcile(repoPath);

      expect(report.messages.some((m) => m.severity === "info")).toBe(true);
    });

    it("catches a modification to an already-documented, uncommitted file", () => {
      commitFile("reconcile-modified.js", documentedSource, "initial");
      documentationService.writeDoc(repoPath, "reconcile-modified.js", 0, documentedSource.length, "greets someone");

      // Uncommitted edit -- content changes on disk only.
      writeFileSync(join(repoPath, "reconcile-modified.js"), `function greet(name) {\n  return "hi " + name;\n}\n`);

      const report = syncService.reconcile(repoPath);

      expect(report.messages.some((m) => m.severity === "warning" || m.severity === "error")).toBe(true);
    });

    it("catches a deletion of an already-documented, uncommitted file", () => {
      commitFile("reconcile-deleted.js", documentedSource, "initial");
      documentationService.writeDoc(repoPath, "reconcile-deleted.js", 0, documentedSource.length, "greets someone");

      // Uncommitted deletion -- just removed from disk, no git rm/commit.
      unlinkSync(join(repoPath, "reconcile-deleted.js"));

      const report = syncService.reconcile(repoPath);

      expect(report.messages.some((m) => m.text.includes("greets someone"))).toBe(true);
      expect(existsSync(documentationService.storagePathFor(repoPath, "reconcile-deleted.js"))).toBe(false);
    });

    it("does not correlate an uncommitted rename -- reports it as an unrelated delete and add", () => {
      commitFile("reconcile-old-name.js", documentedSource, "initial");
      documentationService.writeDoc(repoPath, "reconcile-old-name.js", 0, documentedSource.length, "greets someone");

      // Uncommitted rename via plain fs operations, no git mv/commit.
      const content = readFileSync(join(repoPath, "reconcile-old-name.js"), "utf-8");
      unlinkSync(join(repoPath, "reconcile-old-name.js"));
      writeFileSync(join(repoPath, "reconcile-new-name.js"), content);

      const report = syncService.reconcile(repoPath);

      // Old identity is reported gone, with its text surfaced for manual recovery...
      expect(report.messages.some((m) => m.text.includes("greets someone"))).toBe(true);
      expect(existsSync(documentationService.storagePathFor(repoPath, "reconcile-old-name.js"))).toBe(false);
      // ...and the new file shows up as a completely separate, undocumented file --
      // not linked to the old one. This is the accepted, honest limitation.
      expect(report.messages.some((m) => m.severity === "info")).toBe(true);
      expect(existsSync(documentationService.storagePathFor(repoPath, "reconcile-new-name.js"))).toBe(false);
    });

    it("ignores non-source files", () => {
      commitFile("README.md", "# hello\n", "initial");
      writeFileSync(join(repoPath, "README.md"), "# hello world\n");

      const report = syncService.reconcile(repoPath);

      expect(report.messages).toEqual([]);
    });

    it("does not touch the git sync pointer at all", () => {
      commitFile("a.js", "const a = 1;\n", "initial");
      syncService.sync(repoPath);
      const pointerBefore = gitService.getLastSyncedCommit(repoPath);

      writeFileSync(join(repoPath, "untracked-new.js"), undocumentedSource);
      syncService.reconcile(repoPath);

      expect(gitService.getLastSyncedCommit(repoPath)).toBe(pointerBefore);
    });
  });

  // Real bug found via manual testing against a real repo with vendored
  // third-party libraries (jQuery, Select2, XRegExp) checked into it: a
  // full Babel AST parse of a handful of large, undocumented files
  // accounted for ~50 of a ~93-second reconcile() pass -- these tests use a
  // single huge string literal to get a real file well past
  // LARGE_FILE_THRESHOLD_BYTES while keeping the AST itself trivial (fast
  // to actually parse here), rather than a real dense/minified file that
  // would make the test suite itself slow.
  function bigSource(): string {
    const padding = "A".repeat(LARGE_FILE_THRESHOLD_BYTES + 1000);
    return `const bigValue = "${padding}";\nfunction greet(name) {\n  console.log("hi " + name);\n}\n`;
  }

  describe("skipping large, undocumented files in bulk passes", () => {
    it("reconcile() skips a large file with zero documentation", () => {
      const big = bigSource();
      writeFileSync(join(repoPath, "big.js"), big);
      // Deliberately no git add/commit -- reconcile() catches uncommitted
      // files too, and this is the simplest way to get it in front of it.

      const report = syncService.reconcile(repoPath);

      expect(report.messages.some((m) => m.relativePath === "big.js")).toBe(false);
    });

    it("reconcile() does NOT skip a large file that has even one documented record", () => {
      const big = bigSource();
      writeFileSync(join(repoPath, "big.js"), big);
      const functionStart = big.indexOf("function greet");
      documentationService.writeDoc(repoPath, "big.js", functionStart, big.length, "greets someone");

      // Modify the documented function -- if the file were wrongly skipped,
      // this drift would never be reported at all.
      const modified = big.replace('console.log("hi " + name)', 'return "hi " + name');
      writeFileSync(join(repoPath, "big.js"), modified);

      const report = syncService.reconcile(repoPath);

      expect(report.messages.some((m) => m.relativePath === "big.js" && m.severity === "warning")).toBe(true);
    });

    // Real bug found via manual testing: jquery.min.js (89,795 bytes) and
    // select2.full.min.js (79,212 bytes) both sat comfortably UNDER
    // LARGE_FILE_THRESHOLD_BYTES (100,000), so the size check alone let
    // them straight through -- despite each taking 7-15 seconds to parse.
    // Minification packs far more real code into far fewer bytes than
    // byte-size alone can account for; this is what the line-density check
    // exists for. Everything crammed onto one line, deliberately, the same
    // structural shape a real minified file has.
    function minifiedStyleSource(): string {
      const padding = "A".repeat(MINIFIED_MIN_SIZE_BYTES + 1000);
      return `const bigValue = "${padding}"; function greet(name) {console.log("hi " + name);}`;
    }

    it("reconcile() skips a file that's densely minified even though it's UNDER the size threshold", () => {
      const minified = minifiedStyleSource();
      expect(Buffer.byteLength(minified)).toBeLessThan(LARGE_FILE_THRESHOLD_BYTES);
      writeFileSync(join(repoPath, "min.js"), minified);

      const report = syncService.reconcile(repoPath);

      expect(report.messages.some((m) => m.relativePath === "min.js")).toBe(false);
    });

    it("reconcile() does NOT skip a densely-minified file that has documentation", () => {
      const minified = minifiedStyleSource();
      writeFileSync(join(repoPath, "min.js"), minified);
      const functionStart = minified.indexOf("function greet");
      documentationService.writeDoc(repoPath, "min.js", functionStart, minified.length, "greets someone");

      const modified = minified.replace('console.log("hi " + name)', 'return "hi " + name');
      writeFileSync(join(repoPath, "min.js"), modified);

      const report = syncService.reconcile(repoPath);

      expect(report.messages.some((m) => m.relativePath === "min.js" && m.severity === "warning")).toBe(true);
    });

    it("does NOT skip a small file just because it happens to be on one line", () => {
      // MINIFIED_MIN_SIZE_BYTES exists specifically to guard against this --
      // a short one-liner is cheap to parse regardless of density.
      writeFileSync(join(repoPath, "oneline.js"), 'function greet(name) { return "hi " + name; }');

      const report = syncService.reconcile(repoPath);

      expect(report.messages.some((m) => m.relativePath === "oneline.js")).toBe(true);
    });

    it("sync()'s diff loop skips a large, newly-added, undocumented file", () => {
      commitFile("unrelated.js", "const a = 1;\n", "initial");
      syncService.sync(repoPath); // establish a sync pointer

      commitFile("big.js", bigSource(), "add a big file");
      const report = syncService.sync(repoPath);

      expect(report.messages.some((m) => m.relativePath === "big.js")).toBe(false);
    });

    it("fullScan (the very first sync for a repo) skips a large, undocumented file", () => {
      commitFile("big.js", bigSource(), "initial commit, includes a big file");

      const report = syncService.sync(repoPath);

      expect(report.messages.some((m) => m.relativePath === "big.js")).toBe(false);
    });

    it("handleRenameEvent skips a large, undocumented renamed file ONLY when explicitly opted in (sync's own usage)", () => {
      const big = bigSource();
      writeFileSync(join(repoPath, "big-old.js"), big);
      writeFileSync(join(repoPath, "big-new.js"), big);

      const withOptIn = syncService.handleRenameEvent(repoPath, "big-old.js", "big-new.js", {
        allowSkipLargeUndocumented: true,
      });
      expect(withOptIn.some((m) => m.relativePath === "big-new.js")).toBe(false);

      // Without the option -- LiveWatchService's own usage for a live
      // rename -- the exact same file is still checked in full.
      const withoutOptIn = syncService.handleRenameEvent(repoPath, "big-old.js", "big-new.js");
      expect(withoutOptIn.some((m) => m.relativePath === "big-new.js")).toBe(true);
    });

    it("handleFileEvent (the live, single-file path) never skips, regardless of size", () => {
      writeFileSync(join(repoPath, "big.js"), bigSource());

      const messages = syncService.handleFileEvent(repoPath, "big.js");

      expect(messages.some((m) => m.relativePath === "big.js")).toBe(true);
    });

    it("a skip is reversible, not permanent -- documenting the file later makes future bulk passes check it again", () => {
      const big = bigSource();
      writeFileSync(join(repoPath, "big.js"), big);
      expect(syncService.reconcile(repoPath).messages.some((m) => m.relativePath === "big.js")).toBe(false);

      const functionStart = big.indexOf("function greet");
      documentationService.writeDoc(repoPath, "big.js", functionStart, big.length, "greets someone");

      const modified = big.replace('console.log("hi " + name)', 'return "hi " + name');
      writeFileSync(join(repoPath, "big.js"), modified);

      const report = syncService.reconcile(repoPath);
      expect(report.messages.some((m) => m.relativePath === "big.js" && m.severity === "warning")).toBe(true);
    });

    describe("checkFileOnDemand (catches up whatever the bulk skip deferred, when the file is actually opened)", () => {
      it("returns null (nothing to do) for a normal-sized file already covered by the bulk pass", () => {
        commitFile("normal.js", undocumentedSource, "initial");
        syncService.reconcile(repoPath);

        expect(syncService.checkFileOnDemand(repoPath, "normal.js")).toBeNull();
      });

      it("returns real messages for a large, undocumented file the bulk pass skipped", () => {
        writeFileSync(join(repoPath, "big.js"), bigSource());
        syncService.reconcile(repoPath); // skips it

        const messages = syncService.checkFileOnDemand(repoPath, "big.js");

        expect(messages).not.toBeNull();
        expect(messages?.some((m) => m.relativePath === "big.js")).toBe(true);
      });

      it("returns null for a large file that already has documentation (never skippable)", () => {
        const big = bigSource();
        writeFileSync(join(repoPath, "big.js"), big);
        const functionStart = big.indexOf("function greet");
        documentationService.writeDoc(repoPath, "big.js", functionStart, big.length, "greets someone");

        expect(syncService.checkFileOnDemand(repoPath, "big.js")).toBeNull();
      });
    });
  });

  describe("resilience against a single unparseable file (real crash found via manual testing)", () => {
    it("a full scan reports the parse failure but still checks every other file", () => {
      commitFile("good-a.js", "const a = 1;\n", "add good file a");
      // Genuinely invalid syntax -- unbalanced braces.
      commitFile("broken.js", "function broken( {{{ not valid js at all", "add broken file");
      commitFile("good-b.js", "const b = 2;\n", "add good file b");

      let report: ReturnType<typeof syncService.sync> | undefined;
      expect(() => {
        report = syncService.sync(repoPath);
      }).not.toThrow();

      const errorMessage = report!.messages.find((m) => m.severity === "error" && m.text.includes("broken.js"));
      expect(errorMessage).toBeDefined();

      // Both good files still got checked despite the broken one sitting between them.
      const infoMessages = report!.messages.filter((m) => m.severity === "info");
      expect(infoMessages.length).toBeGreaterThanOrEqual(2);
    });

    it("handleFileEvent (the live path) does not crash on an unparseable live edit", () => {
      writeFileSync(join(repoPath, "mid-typing.js"), "function incomplete( {{{");

      let messages: ReturnType<typeof syncService.handleFileEvent> = [];
      expect(() => {
        messages = syncService.handleFileEvent(repoPath, "mid-typing.js");
      }).not.toThrow();

      expect(messages.some((m) => m.severity === "error" && m.text.includes("mid-typing.js"))).toBe(true);
    });
  });
});
