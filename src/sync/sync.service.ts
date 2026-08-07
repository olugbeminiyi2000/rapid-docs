import { Injectable } from "@nestjs/common";
import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { DocumentationService, Message } from "../ast/documentation.service.js";
import { GitService } from "../git/git.service.js";

const SOURCE_FILE_PATTERN = /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/;

// Real bug found via manual testing against a real repo with several
// vendored third-party libraries (jQuery, Select2, XRegExp) checked into a
// Django staticfiles directory -- of 90 real source files, 6 of them alone
// accounted for ~50 of a ~93-second reconcile() pass, because a full Babel
// AST parse of something the size of jQuery is genuinely expensive, and
// nobody documents a vendored library's own internals. 100KB is chosen from
// real evidence, not a guess: those vendor files were 170KB-292KB; the
// largest genuinely hand-written file in that same repo was ~19KB -- wide,
// comfortable margin on both sides.
export const LARGE_FILE_THRESHOLD_BYTES = 100_000;

// Byte size alone isn't a reliable signal once minification is involved --
// found for real: jquery.min.js (89,795 bytes) and select2.full.min.js
// (79,212 bytes) both sat UNDER LARGE_FILE_THRESHOLD_BYTES, yet still took
// 15s/7s to parse each, because minification packs the same amount of real
// code into far fewer bytes than hand-written source ever would. Line
// density is what actually distinguishes them: those two files measured
// ~30,000-40,000 bytes per line (essentially the whole file on 1-2 lines),
// while EVERY normal file checked -- including the large, UNMINIFIED
// jquery.js itself -- measured under 50 bytes per line, real files
// included, not just short ones. 1,000 bytes/line leaves a roughly
// 30x-40x safety margin under the real minified files while sitting
// enormously above anything a human would ever write on one line.
// MINIFIED_MIN_SIZE_BYTES guards the check itself from firing on a
// trivially short, genuinely-one-line file that's simply too small to be
// expensive regardless of its density.
export const MINIFIED_MIN_SIZE_BYTES = 10_000;
export const MINIFIED_DENSITY_BYTES_PER_LINE = 1_000;

export interface SyncReport {
  messages: Message[];
}

@Injectable()
export class SyncService {
  constructor(
    private readonly gitService: GitService,
    private readonly documentationService: DocumentationService
  ) {}

  sync(repoPath: string): SyncReport {
    const currentCommit = this.gitService.getHeadCommit(repoPath);

    // No commits exist in this repo yet -- there's no commit history for a
    // commit-based sync to compare against at all. reconcile() (always run
    // right after this, and independent of commit history) still covers
    // whatever's genuinely on disk, so nothing is lost by skipping here.
    // Once a first commit is made, lastSyncedCommit will still be null and
    // the normal first-time full scan below runs exactly once, as intended.
    if (currentCommit === null) {
      return { messages: [] };
    }

    const lastSyncedCommit = this.gitService.getLastSyncedCommit(repoPath);

    if (lastSyncedCommit === null) {
      const messages = this.fullScan(repoPath);
      this.gitService.setLastSyncedCommit(repoPath, currentCommit);
      return { messages };
    }

    if (lastSyncedCommit === currentCommit) {
      return { messages: [] };
    }

    const diffResult = this.gitService.diff(repoPath, lastSyncedCommit, currentCommit);
    const messages: Message[] = [];

    for (const relativePath of diffResult.deleted) {
      messages.push(...this.documentationService.handleDeletedFile(repoPath, relativePath));
    }

    for (const entry of diffResult.renamed) {
      messages.push(...this.handleRenameEvent(repoPath, entry.from, entry.to, { allowSkipLargeUndocumented: true }));
    }

    for (const relativePath of [...diffResult.added, ...diffResult.modified]) {
      if (SOURCE_FILE_PATTERN.test(relativePath)) {
        messages.push(...this.checkAndReportUnlessSkippable(repoPath, relativePath));
      }
    }

    this.gitService.setLastSyncedCommit(repoPath, currentCommit);

    return { messages };
  }

  // Entry point for the "live" path (a file changed on disk, no commit involved).
  // Decides delete-vs-changed from the filesystem itself, not from whatever the
  // caller believes the event type was -- checkFile's readFileSync throws on a
  // missing path, so routing must never rely on the caller classifying correctly.
  handleFileEvent(repoPath: string, relativePath: string): Message[] {
    if (existsSync(join(repoPath, relativePath))) {
      return this.checkAndReport(repoPath, relativePath);
    }

    return this.documentationService.handleDeletedFile(repoPath, relativePath);
  }

  // Shared by both the git-history path (sync) and the live-watching path
  // (LiveWatchService): migrate identity first (if there's anything to migrate),
  // then check accuracy -- a rename says nothing about whether content also drifted.
  //
  // allowSkipLargeUndocumented defaults to false (always check) because the
  // two callers genuinely need different behavior, not because one is more
  // "correct": LiveWatchService calls this for a rename that just happened,
  // live, to ONE specific file -- a real, deliberate signal worth checking
  // regardless of size, the same reasoning handleFileEvent already follows.
  // sync()'s own rename loop, by contrast, can process many renames at once
  // after a big pull, which is exactly the "bulk, blanket" shape the skip
  // exists for -- so it opts in explicitly.
  handleRenameEvent(
    repoPath: string,
    oldRelativePath: string,
    newRelativePath: string,
    options: { allowSkipLargeUndocumented?: boolean } = {}
  ): Message[] {
    if (existsSync(this.documentationService.storagePathFor(repoPath, oldRelativePath))) {
      this.documentationService.renameFile(repoPath, oldRelativePath, newRelativePath);
    }

    if (!SOURCE_FILE_PATTERN.test(newRelativePath)) {
      return [];
    }

    return options.allowSkipLargeUndocumented
      ? this.checkAndReportUnlessSkippable(repoPath, newRelativePath)
      : this.checkAndReport(repoPath, newRelativePath);
  }

  // Catches whatever happened while the app was closed AND never got
  // committed -- the one gap neither sync() (needs a commit) nor LiveWatchService
  // (needs to have been running) can see. Compares current disk state directly
  // against stored records; no git commits or sync pointer involved at all.
  // Deliberately does not attempt rename correlation: a one-time snapshot
  // comparison has no timing signal and no cached prior content to compare
  // against, so an uncommitted rename here just looks like an unrelated
  // delete-and-add, same as any other case with zero shared basis for pairing.
  reconcile(repoPath: string): SyncReport {
    const messages: Message[] = [];

    for (const relativePath of this.gitService.listWorkingTreeFiles(repoPath)) {
      if (SOURCE_FILE_PATTERN.test(relativePath)) {
        messages.push(...this.checkAndReportUnlessSkippable(repoPath, relativePath));
      }
    }

    for (const relativePath of this.documentationService.listDocumentedFileIds(repoPath)) {
      if (!existsSync(join(repoPath, relativePath))) {
        messages.push(...this.documentationService.handleDeletedFile(repoPath, relativePath));
      }
    }

    return { messages };
  }

  // Reads the CURRENT state fresh, every time -- deliberately not cached
  // anywhere. That's what makes a skip reversible rather than permanent:
  // the moment a large file gains even one documented record, this starts
  // returning false for it, and every future bulk pass checks it in full
  // again, automatically, with nothing to separately invalidate.
  private shouldSkipBulkCheck(repoPath: string, relativePath: string): boolean {
    const fullPath = join(repoPath, relativePath);
    if (!existsSync(fullPath)) return false;

    const size = statSync(fullPath).size;
    const isLarge = size > LARGE_FILE_THRESHOLD_BYTES;
    const isDenselyMinified = size > MINIFIED_MIN_SIZE_BYTES && this.isDenselyMinified(fullPath, size);
    if (!isLarge && !isDenselyMinified) return false;

    const storage = this.documentationService.loadStorage(repoPath, relativePath);
    return Object.keys(storage.records).length === 0;
  }

  private isDenselyMinified(fullPath: string, size: number): boolean {
    const content = readFileSync(fullPath, "utf-8");
    const lineCount = content.split("\n").length;
    return size / lineCount > MINIFIED_DENSITY_BYTES_PER_LINE;
  }

  // The one new entry point BULK callers (reconcile, sync's diff loop,
  // sync's own rename handling, fullScan) use instead of the raw
  // checkAndReport -- targeted, single-file callers (handleFileEvent,
  // LiveWatchService's own rename handling) keep calling checkAndReport
  // directly, unconditionally, since a live edit or live rename is a real,
  // deliberate signal about ONE file, not a blanket sweep this skip logic
  // was ever meant to apply to.
  private checkAndReportUnlessSkippable(repoPath: string, relativePath: string): Message[] {
    if (this.shouldSkipBulkCheck(repoPath, relativePath)) {
      return [];
    }
    return this.checkAndReport(repoPath, relativePath);
  }

  // Called by the renderer right after opening a file -- catches up
  // whatever the bulk skip logic deferred, the moment someone actually
  // looks at the file it was deferred for. Reuses the EXACT SAME test bulk
  // callers use to decide whether to skip in the first place: if it's
  // still true right now, the file was definitely never checked by the
  // last bulk pass (a bulk pass always skips whenever this test is true),
  // so catching up is genuinely needed. If it's false, the bulk pass
  // already checked it (or it was never skippable to begin with) -- a real
  // no-op, not just an assumed one. Returns null (not an empty array) for
  // that no-op case specifically, so the caller knows not to bother
  // replacing this file's messages or pushing a live update for nothing.
  checkFileOnDemand(repoPath: string, relativePath: string): Message[] | null {
    if (!this.shouldSkipBulkCheck(repoPath, relativePath)) {
      return null;
    }
    return this.checkAndReport(repoPath, relativePath);
  }

  private fullScan(repoPath: string): Message[] {
    const messages: Message[] = [];

    for (const relativePath of this.gitService.listTrackedFiles(repoPath)) {
      if (SOURCE_FILE_PATTERN.test(relativePath)) {
        messages.push(...this.checkAndReportUnlessSkippable(repoPath, relativePath));
      }
    }

    return messages;
  }

  // Deliberately swallows a parse failure here, rather than letting it
  // propagate: every caller of this method is either a batch scan (one bad
  // file shouldn't abort checking every other file) or a live-edit event
  // (a user mid-typing an incomplete function is completely normal, and
  // should never be able to crash the whole live-watching session).
  private checkAndReport(repoPath: string, relativePath: string): Message[] {
    try {
      const report = this.documentationService.checkFile(repoPath, relativePath);
      return this.documentationService.generateMessages(repoPath, relativePath, report);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return [
        { severity: "error", text: `Could not check "${relativePath}": ${reason}`, relativePath, recordId: null, ranges: [] },
      ];
    }
  }
}
