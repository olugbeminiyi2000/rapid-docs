import { Injectable } from "@nestjs/common";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Deliberately lenient: a missed rename silently orphans a DocRecord with nothing
// pointing to it, while a false-positive rename is caught loudly by DocumentationService's
// own drift detection (checkFile) once it's run against the wrongly-matched content.
const RENAME_SIMILARITY_THRESHOLD = 1;

// Lives inside .git/, not the tracked working tree: this pointer is per-machine,
// per-installation sync progress, not shared documentation content. Anything under
// .git/ is structurally un-trackable by git itself, so it can never be committed,
// pushed, or pulled -- guaranteeing one collaborator's sync progress can never
// silently overwrite another's.
const SYNC_POINTER_DIR = join(".git", "rapid-docs");
const SYNC_POINTER_FILE = "last-sync.json";

export interface RenamedEntry {
  from: string;
  to: string;
  similarity: number;
}

export interface GitDiffResult {
  added: string[];
  deleted: string[];
  modified: string[];
  renamed: RenamedEntry[];
}

@Injectable()
export class GitService {
  // Returns null for a real, common state: a repo that genuinely has zero
  // commits yet (freshly `git init`-ed, or a brand-new empty GitHub repo
  // before the first commit) -- `git rev-parse HEAD` exits non-zero in
  // exactly this case, which is not an error condition to reject the repo
  // over, just an absence of history for a commit-based sync to compare
  // against yet. Any OTHER git failure still propagates, unrecognized.
  getHeadCommit(repoPath: string): string | null {
    try {
      return this.runGit(repoPath, ["rev-parse", "HEAD"]).trim();
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      if (stderr.includes("unknown revision") || stderr.includes("ambiguous argument")) {
        return null;
      }
      throw error;
    }
  }

  listTrackedFiles(repoPath: string): string[] {
    const output = this.runGit(repoPath, ["ls-files"]);
    return output.split("\n").filter((line) => line.trim().length > 0);
  }

  // Tracked files PLUS untracked-but-not-gitignored files -- unlike
  // listTrackedFiles, this catches a file the user created and never even
  // `git add`-ed, while still excluding node_modules/build output/etc. Used
  // for reconciliation, which cares about "what's really on disk" rather than
  // "what's been staged."
  //
  // `--cached` reflects git's INDEX, not the actual filesystem -- a plain
  // delete (no `git rm`, no commit) never touches the index, so a file gone
  // from disk still comes back from this command. Filtering by existsSync
  // here, once, at the source, is what every caller actually wants ("what's
  // really on disk right now"); every caller used to have to remember this
  // guard themselves, and one (the file-tree's own listing) had forgotten it,
  // leaving a deleted file stuck in the UI, unclickable, until something else
  // happened to reload the whole list.
  listWorkingTreeFiles(repoPath: string): string[] {
    const output = this.runGit(repoPath, ["ls-files", "--others", "--exclude-standard", "--cached"]);
    return output
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .filter((relativePath) => existsSync(join(repoPath, relativePath)));
  }

  // Real bug found via manual testing against a real repo with a Python
  // virtualenv sitting inside it (correctly gitignored, never tracked, but
  // still ~20,000 files on disk): LiveWatchService's chokidar watcher had
  // no notion of gitignore at all, and walked/watched every one of them
  // anyway -- confirmed directly, watch-setup went from 13.5s to 321ms once
  // that one directory was excluded. `--directory` is what makes this fast
  // and useful rather than just correct: without it, git would expand an
  // ignored directory into every individual file inside it (thousands of
  // entries for one real ignored folder); with it, an entire ignored
  // directory collapses to a single entry, letting chokidar skip
  // descending into it AT ALL rather than walking in and filtering after.
  // Deliberately git's own ignore resolution, not a hardcoded guess-list of
  // "common heavy directory names" (venv, node_modules, ...) -- generalizes
  // correctly to whatever a given repo's own .gitignore actually excludes
  // (dist/, build/, .next/, target/, anything), the same file every other
  // git-facing tool in this codebase already treats as authoritative.
  listIgnoredPaths(repoPath: string): string[] {
    const output = this.runGit(repoPath, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"]);
    return output.split("\n").filter((line) => line.trim().length > 0);
  }

  getLastSyncedCommit(repoPath: string): string | null {
    const path = this.pointerPath(repoPath);

    if (!existsSync(path)) {
      return null;
    }

    const raw = readFileSync(path, "utf-8");
    return (JSON.parse(raw) as { commit: string }).commit;
  }

  setLastSyncedCommit(repoPath: string, commitHash: string): void {
    const dir = join(repoPath, SYNC_POINTER_DIR);

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(this.pointerPath(repoPath), JSON.stringify({ commit: commitHash }, null, 2));
  }

  diff(repoPath: string, fromCommit: string, toCommit: string): GitDiffResult {
    const output = this.runGit(repoPath, [
      "diff",
      "--raw",
      "--no-color",
      `-M${RENAME_SIMILARITY_THRESHOLD}%`,
      fromCommit,
      toCommit,
    ]);

    const result: GitDiffResult = { added: [], deleted: [], modified: [], renamed: [] };

    for (const line of output.split("\n")) {
      if (!line.trim()) continue;

      const [metaPart, ...paths] = line.split("\t");
      const status = metaPart.split(" ").pop()!;
      const letter = status[0];

      if (letter === "A") {
        result.added.push(paths[0]);
      } else if (letter === "D") {
        result.deleted.push(paths[0]);
      } else if (letter === "M") {
        result.modified.push(paths[0]);
      } else if (letter === "R") {
        result.renamed.push({
          from: paths[0],
          to: paths[1],
          similarity: parseInt(status.slice(1), 10),
        });
      }
    }

    return result;
  }

  // Compares two arbitrary strings of content -- no commit, no repo, nothing
  // committed required -- by reusing git's own proven rename-similarity algorithm
  // via `git diff --no-index` on two throwaway directories. Used for correlating
  // a live filesystem "unlink" with a live "add" when nothing has been committed yet.
  compareContent(oldContent: string, newContent: string): { similarity: number } | null {
    const oldDir = mkdtempSync(join(tmpdir(), "rapid-docs-compare-old-"));
    const newDir = mkdtempSync(join(tmpdir(), "rapid-docs-compare-new-"));

    try {
      // Different filenames on each side are essential: if both sides used the
      // same name, identical (or near-identical) content would look like "no
      // change at all" rather than a rename candidate, since git compares paths
      // first -- there'd be nothing to pair.
      writeFileSync(join(oldDir, "old-content"), oldContent);
      writeFileSync(join(newDir, "new-content"), newContent);

      let output: string;
      try {
        output = execFileSync(
          "git",
          ["diff", "--no-index", "--raw", "--no-color", `-M${RENAME_SIMILARITY_THRESHOLD}%`, oldDir, newDir],
          { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
        );
      } catch (error) {
        // git diff --no-index exits 1 when it finds differences -- that's the
        // normal, expected outcome here, not a failure. Its stdout is still valid.
        output = (error as { stdout?: string }).stdout ?? "";
      }

      for (const line of output.split("\n")) {
        if (!line.trim()) continue;

        const [metaPart] = line.split("\t");
        const status = metaPart.split(" ").pop()!;

        if (status[0] === "R") {
          return { similarity: parseInt(status.slice(1), 10) };
        }
      }

      return null;
    } finally {
      rmSync(oldDir, { recursive: true, force: true });
      rmSync(newDir, { recursive: true, force: true });
    }
  }

  private pointerPath(repoPath: string): string {
    return join(repoPath, SYNC_POINTER_DIR, SYNC_POINTER_FILE);
  }

  private runGit(repoPath: string, args: string[]): string {
    // execFileSync's default stdio inherits the child's stderr straight to
    // this process's own console, live, in ADDITION to capturing it onto
    // the thrown error's .stderr property -- confirmed directly, not
    // assumed. That means every expected, already-handled failure (like
    // getHeadCommit's "no commits yet" case) still prints git's raw error
    // text to the terminal, reading as broken even when it's fully handled.
    // Explicit 'pipe' suppresses the live inheritance while still
    // populating error.stderr for callers that need it.
    return execFileSync("git", args, { cwd: repoPath, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  }
}
