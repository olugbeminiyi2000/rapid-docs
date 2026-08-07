import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GitService } from "./git.service.js";

describe("GitService", () => {
  let gitService: GitService;
  let repoPath: string;

  function git(...args: string[]): string {
    return execFileSync("git", args, { cwd: repoPath, encoding: "utf-8" });
  }

  function commitFile(fileName: string, content: string, message: string): string {
    writeFileSync(join(repoPath, fileName), content);
    git("add", fileName);
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD").trim();
  }

  beforeEach(() => {
    gitService = new GitService();
    repoPath = mkdtempSync(join(tmpdir(), "git-service-test-"));
    git("init", "-q");
    git("config", "user.email", "test@test.com");
    git("config", "user.name", "test");
    git("config", "core.autocrlf", "false");
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  describe("getHeadCommit", () => {
    it("returns the current HEAD commit hash", () => {
      const expected = commitFile("a.txt", "hello", "initial");
      expect(gitService.getHeadCommit(repoPath)).toBe(expected);
    });

    // Real bug found via manual end-to-end testing: a brand-new repo with a
    // real .git folder but zero commits (fresh `git init`, or a fresh empty
    // GitHub repo before the first commit -- exactly what a real user tried)
    // made `git rev-parse HEAD` exit non-zero, crashing the whole app with
    // an unhandled exception. A repo with no commits yet is a completely
    // legitimate state, not an error.
    it("returns null for a real repo with no commits yet, instead of throwing", () => {
      expect(() => gitService.getHeadCommit(repoPath)).not.toThrow();
      expect(gitService.getHeadCommit(repoPath)).toBeNull();
    });
  });

  describe("listTrackedFiles", () => {
    it("lists every committed file", () => {
      commitFile("a.txt", "hello", "initial");
      commitFile("b.txt", "world", "second");

      expect(gitService.listTrackedFiles(repoPath).sort()).toEqual(["a.txt", "b.txt"]);
    });

    it("does not include untracked files", () => {
      commitFile("a.txt", "hello", "initial");
      writeFileSync(join(repoPath, "untracked.txt"), "never added");

      expect(gitService.listTrackedFiles(repoPath)).toEqual(["a.txt"]);
    });

    it("returns an empty array for a repo with no commits", () => {
      expect(gitService.listTrackedFiles(repoPath)).toEqual([]);
    });
  });

  describe("listWorkingTreeFiles", () => {
    it("includes tracked files and untracked-but-not-ignored files together", () => {
      commitFile("tracked.txt", "hello", "initial");
      writeFileSync(join(repoPath, "untracked.txt"), "never added");

      expect(gitService.listWorkingTreeFiles(repoPath).sort()).toEqual(["tracked.txt", "untracked.txt"]);
    });

    it("excludes files matched by .gitignore", () => {
      commitFile("tracked.txt", "hello", "initial");
      writeFileSync(join(repoPath, ".gitignore"), "ignored.txt\n");
      writeFileSync(join(repoPath, "ignored.txt"), "should not appear");
      writeFileSync(join(repoPath, "visible.txt"), "should appear");

      const result = gitService.listWorkingTreeFiles(repoPath).sort();

      expect(result).toContain("visible.txt");
      expect(result).not.toContain("ignored.txt");
    });

    it("excludes a tracked file that was deleted from disk WITHOUT `git rm`", () => {
      // Real bug found via manual testing: `git ls-files --cached` reflects
      // git's INDEX, not the actual filesystem -- a plain delete (outside
      // git entirely) never updates the index, so the file kept coming back
      // from this method even though it no longer existed on disk, leaving
      // it stuck in the app's own file tree, unclickable.
      commitFile("tracked.txt", "hello", "initial");
      rmSync(join(repoPath, "tracked.txt"));

      expect(gitService.listWorkingTreeFiles(repoPath)).not.toContain("tracked.txt");
    });
  });

  describe("listIgnoredPaths", () => {
    it("returns an empty array when nothing is gitignored", () => {
      commitFile("tracked.txt", "hello", "initial");
      expect(gitService.listIgnoredPaths(repoPath)).toEqual([]);
    });

    it("collapses an ignored directory to a single entry, not one per file inside it", () => {
      // The whole point: without --directory, git would expand an ignored
      // directory into every individual file inside it -- for a real
      // virtualenv-sized directory, thousands of entries for one real
      // ignored folder, defeating the purpose of asking for this at all.
      commitFile("tracked.txt", "hello", "initial");
      writeFileSync(join(repoPath, ".gitignore"), "ignored_dir/\n");
      mkdirSync(join(repoPath, "ignored_dir", "nested"), { recursive: true });
      writeFileSync(join(repoPath, "ignored_dir", "a.txt"), "one");
      writeFileSync(join(repoPath, "ignored_dir", "nested", "b.txt"), "two");

      const result = gitService.listIgnoredPaths(repoPath);

      expect(result).toEqual(["ignored_dir/"]);
    });

    it("also lists individually-ignored files, not just directories", () => {
      commitFile("tracked.txt", "hello", "initial");
      writeFileSync(join(repoPath, ".gitignore"), "secret.env\n");
      writeFileSync(join(repoPath, "secret.env"), "API_KEY=xyz");

      expect(gitService.listIgnoredPaths(repoPath)).toEqual(["secret.env"]);
    });
  });

  describe("getLastSyncedCommit / setLastSyncedCommit", () => {
    it("returns null when nothing has been synced yet", () => {
      commitFile("a.txt", "hello", "initial");
      expect(gitService.getLastSyncedCommit(repoPath)).toBeNull();
    });

    it("persists and retrieves a synced commit hash", () => {
      const commit = commitFile("a.txt", "hello", "initial");
      gitService.setLastSyncedCommit(repoPath, commit);
      expect(gitService.getLastSyncedCommit(repoPath)).toBe(commit);
    });

    it("overwrites a previously stored pointer rather than merging with it", () => {
      const first = commitFile("a.txt", "hello", "initial");
      gitService.setLastSyncedCommit(repoPath, first);

      const second = commitFile("b.txt", "world", "second");
      gitService.setLastSyncedCommit(repoPath, second);

      expect(gitService.getLastSyncedCommit(repoPath)).toBe(second);
    });

    it("stores the pointer where git itself cannot ever track, commit, or push it", () => {
      const commit = commitFile("a.txt", "hello", "initial");
      gitService.setLastSyncedCommit(repoPath, commit);

      // git add on a path inside .git/ is a guaranteed silent no-op -- proving
      // this pointer can never end up in another collaborator's clone.
      git("add", ".git/rapid-docs/last-sync.json");
      expect(git("status", "--short").trim()).toBe("");
      expect(git("ls-files")).not.toContain("last-sync.json");
    });
  });

  describe("diff", () => {
    it("detects an added file", () => {
      const before = commitFile("a.txt", "hello", "initial");
      const after = commitFile("b.txt", "new file", "add b");

      const result = gitService.diff(repoPath, before, after);

      expect(result).toEqual({
        added: ["b.txt"],
        deleted: [],
        modified: [],
        renamed: [],
      });
    });

    it("detects a deleted file", () => {
      commitFile("a.txt", "hello", "initial");
      const before = commitFile("b.txt", "to be deleted", "add b");
      git("rm", "-q", "b.txt");
      git("commit", "-qm", "remove b");
      const after = git("rev-parse", "HEAD").trim();

      const result = gitService.diff(repoPath, before, after);

      expect(result).toEqual({
        added: [],
        deleted: ["b.txt"],
        modified: [],
        renamed: [],
      });
    });

    it("detects a modified file", () => {
      const before = commitFile("a.txt", "hello", "initial");
      const after = commitFile("a.txt", "hello world", "modify a");

      const result = gitService.diff(repoPath, before, after);

      expect(result).toEqual({
        added: [],
        deleted: [],
        modified: ["a.txt"],
        renamed: [],
      });
    });

    it("detects a pure rename (zero content change) at 100% similarity", () => {
      const before = commitFile("math.ts", "export function add() {}\n", "initial");
      git("mv", "math.ts", "arithmetic.ts");
      git("commit", "-qm", "rename");
      const after = git("rev-parse", "HEAD").trim();

      const result = gitService.diff(repoPath, before, after);

      expect(result.renamed).toEqual([{ from: "math.ts", to: "arithmetic.ts", similarity: 100 }]);
      expect(result.added).toEqual([]);
      expect(result.deleted).toEqual([]);
    });

    // Deliberately keeps one identical line (the header comment) across the rewrite.
    // Proven separately: with ZERO shared lines, similarity is a hard 0%, and no
    // threshold (not even -M0%) can force a rename match -- there's no signal at all.
    const originalMath = `// arithmetic helpers\nexport function add(a, b) {\n  return a + b;\n}\n`;
    const totallyRewritten =
      `// arithmetic helpers\n` +
      `export function mean(values) {\n` +
      `  return values.reduce((a, b) => a + b, 0) / values.length;\n` +
      `}\n\n` +
      `export function median(values) {\n` +
      `  const sorted = [...values].sort((a, b) => a - b);\n` +
      `  return sorted[Math.floor(sorted.length / 2)];\n` +
      `}\n`;

    it("sanity check: git's own strict default (-M, 50%) would NOT see this fixture as a rename", () => {
      const before = commitFile("math2.ts", originalMath, "initial2");
      git("mv", "math2.ts", "stats2.ts");
      writeFileSync(join(repoPath, "stats2.ts"), totallyRewritten);
      git("add", "stats2.ts");
      git("commit", "-qm", "rename and rewrite 2");
      const after = git("rev-parse", "HEAD").trim();

      const strictOutput = execFileSync("git", ["diff", "--raw", "-M50%", before, after], {
        cwd: repoPath,
        encoding: "utf-8",
      });

      const statuses = strictOutput
        .trim()
        .split("\n")
        .map((line) => line.split("\t")[0].split(" ").pop()![0])
        .sort();

      expect(statuses).toEqual(["A", "D"]);
    });

    it("still detects a rename combined with a near-total content rewrite, because of the lenient threshold", () => {
      const before = commitFile("math.ts", originalMath, "initial");
      git("mv", "math.ts", "stats.ts");
      writeFileSync(join(repoPath, "stats.ts"), totallyRewritten);
      git("add", "stats.ts");
      git("commit", "-qm", "rename and rewrite");
      const after = git("rev-parse", "HEAD").trim();

      const result = gitService.diff(repoPath, before, after);

      expect(result.renamed.length).toBe(1);
      expect(result.renamed[0].from).toBe("math.ts");
      expect(result.renamed[0].to).toBe("stats.ts");
      expect(result.added).toEqual([]);
      expect(result.deleted).toEqual([]);
    });

    it("collapses multiple intermediate commits (add, edit, delete) into an empty net diff", () => {
      const before = commitFile("a.txt", "hello", "initial");

      writeFileSync(join(repoPath, "temp.txt"), "temp v1");
      git("add", "temp.txt");
      git("commit", "-qm", "add temp");

      writeFileSync(join(repoPath, "temp.txt"), "temp v2");
      git("add", "temp.txt");
      git("commit", "-qm", "edit temp");

      git("rm", "-q", "temp.txt");
      git("commit", "-qm", "remove temp");
      const after = git("rev-parse", "HEAD").trim();

      const result = gitService.diff(repoPath, before, after);

      expect(result).toEqual({
        added: [],
        deleted: [],
        modified: [],
        renamed: [],
      });
    });

    it("categorizes an add, delete, modify, and rename together in a single diff correctly", () => {
      commitFile("keep.txt", "unchanged forever", "initial");
      commitFile("to-delete.txt", "will be deleted", "add to-delete");
      commitFile("to-modify.txt", "original", "add to-modify");
      const before = commitFile("old-name.txt", "rename target content", "add old-name");

      writeFileSync(join(repoPath, "to-modify.txt"), "changed");
      git("rm", "-q", "to-delete.txt");
      git("mv", "old-name.txt", "new-name.txt");
      writeFileSync(join(repoPath, "brand-new.txt"), "brand new file");
      git("add", "brand-new.txt", "to-modify.txt");
      git("commit", "-qm", "combined changes");
      const after = git("rev-parse", "HEAD").trim();

      const result = gitService.diff(repoPath, before, after);

      expect(result.added).toEqual(["brand-new.txt"]);
      expect(result.deleted).toEqual(["to-delete.txt"]);
      expect(result.modified).toEqual(["to-modify.txt"]);
      expect(result.renamed).toEqual([{ from: "old-name.txt", to: "new-name.txt", similarity: 100 }]);
    });
  });

  describe("compareContent", () => {
    it("reports 100% similarity for byte-identical content, with no repo involved at all", () => {
      const content = "export function add(a, b) {\n  return a + b;\n}\n";

      const result = gitService.compareContent(content, content);

      expect(result).toEqual({ similarity: 100 });
    });

    it("reports a nonzero similarity when meaningful content is shared", () => {
      const oldContent = "// arithmetic helpers\nexport function add(a, b) {\n  return a + b;\n}\n";
      const newContent =
        "// arithmetic helpers\n" +
        "export function mean(values) {\n" +
        "  return values.reduce((a, b) => a + b, 0) / values.length;\n" +
        "}\n";

      const result = gitService.compareContent(oldContent, newContent);

      expect(result).not.toBeNull();
      expect(result!.similarity).toBeGreaterThan(0);
    });

    it("returns null when content shares nothing at all", () => {
      const oldContent = "export function add(a, b) {\n  return a + b;\n}\n";
      const newContent =
        "export function mean(values) {\n" +
        "  return values.reduce((a, b) => a + b, 0) / values.length;\n" +
        "}\n\n" +
        "export function median(values) {\n" +
        "  const sorted = [...values].sort((a, b) => a - b);\n" +
        "  return sorted[Math.floor(sorted.length / 2)];\n" +
        "}\n";

      const result = gitService.compareContent(oldContent, newContent);

      expect(result).toBeNull();
    });

    it("works without repoPath being passed or any repo existing at all", () => {
      // Deliberately does not touch `repoPath` / `git()` from the outer scope,
      // to prove compareContent is entirely repo-independent.
      expect(() => gitService.compareContent("hello", "hello")).not.toThrow();
    });
  });
});
