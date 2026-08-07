import { Injectable } from "@nestjs/common";
import { FSWatcher, watch } from "chokidar";
import { EventEmitter } from "events";
import { readFileSync } from "fs";
import { join, relative, sep } from "path";
import { Message } from "../ast/documentation.service.js";
import { GitService } from "../git/git.service.js";
import { SyncService } from "./sync.service.js";

const SOURCE_FILE_PATTERN = /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/;
const DEFAULT_CORRELATION_WINDOW_MS = 500;

// Must match DocumentationService's own STORAGE_DIR exactly -- duplicated
// rather than imported, since this service only ever needs the bare string,
// not the rest of DocumentationService's surface.
const STORAGE_DIR = ".rapid-docs";

interface PendingEntry {
  content: string;
  timer: NodeJS.Timeout;
}

// Watches the filesystem directly (via chokidar), independent of git and
// independent of which tool made the change -- catches uncommitted edits made
// through any external tool, for as long as this service is running.
//
// A rename surfaces as a separate "unlink" (old path) and "add" (new path)
// event, and -- confirmed empirically, not assumed -- chokidar does not
// guarantee which one arrives first. So both directions are held briefly and
// checked against the opposite pending map, not just one.
@Injectable()
export class LiveWatchService extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private repoPath = "";
  private correlationWindowMs = DEFAULT_CORRELATION_WINDOW_MS;
  private readonly contentCache = new Map<string, string>();
  private readonly pendingUnlinks = new Map<string, PendingEntry>();
  private readonly pendingAdds = new Map<string, PendingEntry>();

  constructor(
    private readonly gitService: GitService,
    private readonly syncService: SyncService
  ) {
    super();
  }

  start(repoPath: string, correlationWindowMs = DEFAULT_CORRELATION_WINDOW_MS): Promise<void> {
    this.repoPath = repoPath;
    this.correlationWindowMs = correlationWindowMs;

    // Prime the cache for every file that already exists when watching starts.
    // chokidar's ignoreInitial:true (deliberately) never fires "add" for these,
    // so without this, a file nobody has touched yet this session would have no
    // cached content -- and moving/renaming it would always be seen as a plain
    // delete, never correlated, no matter how identical the content actually is.
    for (const relativePath of this.gitService.listWorkingTreeFiles(repoPath)) {
      if (!SOURCE_FILE_PATTERN.test(relativePath)) continue;

      const fullPath = join(repoPath, relativePath);
      this.contentCache.set(fullPath, readFileSync(fullPath, "utf-8"));
    }

    // Real bug found via manual testing against a repo with a Python
    // virtualenv inside it: correctly gitignored (never tracked), but still
    // ~20,000 real files on disk, and chokidar had no notion of gitignore
    // at all -- it walked and watched every one of them anyway. Confirmed
    // directly: watch-setup for that exact repo went from 13.5s to 321ms
    // once this exclusion was added, which is what was actually behind
    // Windows reporting the whole window as "Not Responding." Read once,
    // up front, rather than per-path -- git resolves .gitignore's own
    // matching rules natively in one call (see GitService.listIgnoredPaths
    // for why --directory specifically is what keeps this fast), so this
    // never has to reimplement gitignore syntax itself.
    // chokidar v4 always calls `ignored` with forward-slash paths, even on
    // Windows -- confirmed directly (logged the raw argument chokidar
    // actually passes), not assumed from docs. path.join produces
    // OS-native separators, which is backslashes on Windows -- comparing
    // those directly against chokidar's forward-slash paths silently never
    // matches at all, found for real the first time this test ran and
    // failed to exclude anything.
    // git's --directory output keeps its own trailing slash ("venv/"), and
    // path.join preserves it through the join too -- left in place, the
    // prefix check below would append a SECOND slash ("venv//"), which a
    // real child path ("venv/inside.js", one slash) never starts with.
    // Confirmed for real: this was still silently failing to exclude
    // anything until the trailing slash was stripped here explicitly.
    const ignoredAbsolutePaths = this.gitService
      .listIgnoredPaths(repoPath)
      .map((relativePath) => join(repoPath, relativePath).split(sep).join("/").replace(/\/$/, ""));

    function isIgnored(path: string): boolean {
      if (/(^|\/)\.git(\/|$)/.test(path)) return true;
      return ignoredAbsolutePaths.some(
        (ignoredPath) => path === ignoredPath || path.startsWith(ignoredPath + "/")
      );
    }

    return new Promise((resolve) => {
      this.watcher = watch(repoPath, {
        ignoreInitial: true,
        ignored: isIgnored,
      });

      this.watcher.on("add", (path) => this.handleAdd(path));
      this.watcher.on("change", (path) => this.handleChange(path));
      this.watcher.on("unlink", (path) => this.handleUnlink(path));
      this.watcher.on("ready", () => resolve());
    });
  }

  async stop(): Promise<void> {
    for (const entry of [...this.pendingUnlinks.values(), ...this.pendingAdds.values()]) {
      clearTimeout(entry.timer);
    }
    this.pendingUnlinks.clear();
    this.pendingAdds.clear();
    this.contentCache.clear();

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  private handleChange(path: string): void {
    const relativePath = this.toRelativePath(path);

    const derivedSourcePath = this.deriveSourcePathFromStoragePath(relativePath);
    if (derivedSourcePath !== null) {
      this.emitMessages([derivedSourcePath], this.syncService.handleFileEvent(this.repoPath, derivedSourcePath));
      return;
    }

    if (!SOURCE_FILE_PATTERN.test(path)) return;

    const content = readFileSync(path, "utf-8");
    this.contentCache.set(path, content);
    this.emitMessages([relativePath], this.syncService.handleFileEvent(this.repoPath, relativePath));
  }

  private handleAdd(path: string): void {
    const relativePath = this.toRelativePath(path);

    const derivedSourcePath = this.deriveSourcePathFromStoragePath(relativePath);
    if (derivedSourcePath !== null) {
      this.emitMessages([derivedSourcePath], this.syncService.handleFileEvent(this.repoPath, derivedSourcePath));
      return;
    }

    if (!SOURCE_FILE_PATTERN.test(path)) return;

    const content = readFileSync(path, "utf-8");

    // Does this new path pair with an "unlink" that already arrived? (Excluding
    // this same path -- a path can't be "renamed" relative to its own prior
    // pending entry; that's just its own earlier create/delete history.)
    for (const [oldPath, entry] of this.pendingUnlinks) {
      if (oldPath === path) continue;
      if (this.gitService.compareContent(entry.content, content) !== null) {
        clearTimeout(entry.timer);
        this.pendingUnlinks.delete(oldPath);
        this.contentCache.set(path, content);
        const oldRelativePath = this.toRelativePath(oldPath);
        this.emitMessages(
          [oldRelativePath, relativePath],
          this.syncService.handleRenameEvent(this.repoPath, oldRelativePath, relativePath)
        );
        return;
      }
    }

    // Not matched yet -- this might still be the first half of a rename whose
    // "unlink" hasn't arrived yet. Hold briefly rather than reporting immediately.
    this.contentCache.set(path, content);
    const timer = setTimeout(() => {
      this.pendingAdds.delete(path);
      this.emitMessages([relativePath], this.syncService.handleFileEvent(this.repoPath, relativePath));
    }, this.correlationWindowMs);
    this.pendingAdds.set(path, { content, timer });
  }

  private handleUnlink(path: string): void {
    const relativePath = this.toRelativePath(path);

    const derivedSourcePath = this.deriveSourcePathFromStoragePath(relativePath);
    if (derivedSourcePath !== null) {
      this.emitMessages([derivedSourcePath], this.syncService.handleFileEvent(this.repoPath, derivedSourcePath));
      return;
    }

    if (!SOURCE_FILE_PATTERN.test(path)) return;

    const cachedContent = this.contentCache.get(path);
    this.contentCache.delete(path);

    if (cachedContent === undefined) {
      this.emitMessages([relativePath], this.syncService.handleFileEvent(this.repoPath, relativePath));
      return;
    }

    // Does this old path pair with an "add" that already arrived? (Excluding
    // this same path, for the same self-match reason as above.)
    for (const [newPath, entry] of this.pendingAdds) {
      if (newPath === path) continue;
      if (this.gitService.compareContent(cachedContent, entry.content) !== null) {
        clearTimeout(entry.timer);
        this.pendingAdds.delete(newPath);
        const newRelativePath = this.toRelativePath(newPath);
        this.emitMessages(
          [relativePath, newRelativePath],
          this.syncService.handleRenameEvent(this.repoPath, relativePath, newRelativePath)
        );
        return;
      }
    }

    // Not matched yet -- hold briefly in case the "add" half arrives shortly after.
    const timer = setTimeout(() => {
      this.pendingUnlinks.delete(path);
      this.emitMessages([relativePath], this.syncService.handleFileEvent(this.repoPath, relativePath));
    }, this.correlationWindowMs);
    this.pendingUnlinks.set(path, { content: cachedContent, timer });
  }

  // A .rapid-docs/<relativePath>.json storage file changing on its own is
  // invisible to SOURCE_FILE_PATTERN -- but it's exactly what happens when a
  // collaborator's newly-added (or edited, or deleted) documentation for
  // otherwise-unchanged code arrives via `git pull`: only the storage file
  // is touched, the source file itself never changes. Without this, that
  // scenario silently stayed stale in the Problems/Dashboard messages until
  // something else happened to also touch the source file. Deriving the
  // corresponding source path and rechecking IT (real evidence, not just
  // this file's own existence) is what makes it update live. `_archive.json`
  // (repo-wide, not mirroring any one source file) is excluded for free:
  // stripping the prefix/suffix from it leaves "_archive", which
  // SOURCE_FILE_PATTERN correctly rejects.
  private deriveSourcePathFromStoragePath(relativePath: string): string | null {
    const prefix = `${STORAGE_DIR}/`;
    if (!relativePath.startsWith(prefix) || !relativePath.endsWith(".json")) {
      return null;
    }

    const candidate = relativePath.slice(prefix.length, -".json".length);
    return SOURCE_FILE_PATTERN.test(candidate) ? candidate : null;
  }

  // Chokidar reports absolute, OS-native paths (backslash-separated on
  // Windows). SyncService/GitService identify files by repo-relative,
  // forward-slash paths (matching what git itself always outputs, regardless
  // of host OS) -- normalizing here keeps the same logical file's identity
  // consistent whether it was discovered via git diffing or via this watcher.
  private toRelativePath(absolutePath: string): string {
    return relative(this.repoPath, absolutePath).split(sep).join("/");
  }

  // relativePaths names every file this batch represents the CURRENT, complete
  // state for -- including a file that just became fully clean, which is
  // exactly the case `messages` alone can't convey (an empty array carries no
  // indication of which file it's empty for). A listener uses relativePaths to
  // know which file(s) to treat as "replace, not append" -- a rename touches
  // two (the old path, now gone entirely, and the new path with its own
  // current messages), everything else touches exactly one.
  private emitMessages(relativePaths: string[], messages: Message[]): void {
    this.emit("messages", relativePaths, messages);
  }
}
