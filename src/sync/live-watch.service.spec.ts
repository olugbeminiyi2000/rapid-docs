import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AstService } from "../ast/ast.service.js";
import { DocumentationService, Message } from "../ast/documentation.service.js";
import { GitService } from "../git/git.service.js";
import { LiveWatchService } from "./live-watch.service.js";
import { SyncService } from "./sync.service.js";

// Empirically measured on this machine: a real rename via renameSync() delivers
// its "add" event roughly 90-100ms before its "unlink" event (chokidar does not
// guarantee unlink-before-add). 300ms leaves comfortable margin over that gap.
const CORRELATION_WINDOW_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition never became true within timeout");
    }
    await sleep(20);
  }
}

describe("LiveWatchService", () => {
  let astService: AstService;
  let documentationService: DocumentationService;
  let gitService: GitService;
  let syncService: SyncService;
  let liveWatchService: LiveWatchService;
  let watchDir: string;
  let receivedMessages: Message[][];
  let receivedRelativePaths: string[][];

  const documentedSource = `function greet(name) {\n  console.log("hi " + name);\n}\n`;

  function git(...args: string[]): string {
    return execFileSync("git", args, { cwd: watchDir, encoding: "utf-8" });
  }

  beforeEach(async () => {
    astService = new AstService();
    documentationService = new DocumentationService(astService);
    gitService = new GitService();
    syncService = new SyncService(gitService, documentationService);
    liveWatchService = new LiveWatchService(gitService, syncService);

    // A real repo, not just a plain temp folder: start() now primes its cache
    // via GitService.listWorkingTreeFiles, which requires one -- consistent
    // with every other part of this tool already assuming a real git repo.
    watchDir = mkdtempSync(join(tmpdir(), "live-watch-test-"));
    git("init", "-q");
    git("config", "user.email", "test@test.com");
    git("config", "user.name", "test");
    git("config", "core.autocrlf", "false");

    receivedMessages = [];
    receivedRelativePaths = [];
    liveWatchService.on("messages", (relativePaths: string[], messages: Message[]) => {
      receivedRelativePaths.push(relativePaths);
      receivedMessages.push(messages);
    });

    await liveWatchService.start(watchDir, CORRELATION_WINDOW_MS);
  });

  afterEach(async () => {
    await liveWatchService.stop();
    // Storage now lives inside watchDir (.rapid-docs/), so removing watchDir
    // removes everything -- no separate storage cleanup needed anymore.
    rmSync(watchDir, { recursive: true, force: true });
  });

  it("detects a pure rename (identical content) and migrates the DocRecord", async () => {
    writeFileSync(join(watchDir, "old-name.js"), documentedSource);
    documentationService.writeDoc(watchDir, "old-name.js", 0, documentedSource.length, "greets someone");

    // Let chokidar register and cache the initial "add" before renaming --
    // otherwise the file can vanish before the watcher ever noticed it existed.
    await sleep(500);

    renameSync(join(watchDir, "old-name.js"), join(watchDir, "new-name.js"));

    await waitFor(
      () => existsSync(documentationService.storagePathFor(watchDir, "new-name.js")),
      CORRELATION_WINDOW_MS + 2000
    );

    expect(existsSync(documentationService.storagePathFor(watchDir, "old-name.js"))).toBe(false);
    expect(existsSync(documentationService.storagePathFor(watchDir, "new-name.js"))).toBe(true);
  }, 10000);

  it("detects a rename combined with a partial rewrite, via the lenient threshold", async () => {
    const original = "// shared header\nfunction greet(name) {\n  console.log(name);\n}\n";
    writeFileSync(join(watchDir, "old-rewrite.js"), original);
    documentationService.writeDoc(watchDir, "old-rewrite.js", 0, original.length, "greets someone");

    await sleep(500);

    unlinkSync(join(watchDir, "old-rewrite.js"));
    await sleep(30);
    writeFileSync(
      join(watchDir, "new-rewrite.js"),
      "// shared header\nfunction farewell(name) {\n  console.log(\"bye \" + name);\n}\n"
    );

    await waitFor(
      () => existsSync(documentationService.storagePathFor(watchDir, "new-rewrite.js")),
      CORRELATION_WINDOW_MS + 2000
    );

    expect(existsSync(documentationService.storagePathFor(watchDir, "old-rewrite.js"))).toBe(false);
    expect(existsSync(documentationService.storagePathFor(watchDir, "new-rewrite.js"))).toBe(true);
  }, 10000);

  it("treats a standalone deletion (no correlated add) as a real deletion once the window expires", async () => {
    writeFileSync(join(watchDir, "to-delete.js"), documentedSource);
    documentationService.writeDoc(watchDir, "to-delete.js", 0, documentedSource.length, "greets someone");

    await sleep(500);

    unlinkSync(join(watchDir, "to-delete.js"));

    await waitFor(() => receivedMessages.some((m) => m.some((msg) => msg.text.includes("greets someone"))), 5000);

    expect(existsSync(documentationService.storagePathFor(watchDir, "to-delete.js"))).toBe(false);
  }, 10000);

  it("treats a standalone addition (no correlated unlink) as a genuine new file once the window expires", async () => {
    // Every "add" is held briefly in case an "unlink" for a matching rename
    // arrives shortly after (since that ordering isn't guaranteed) -- so this
    // is only confirmed once the correlation window has actually passed.
    writeFileSync(join(watchDir, "new-file.js"), documentedSource);

    await waitFor(() => receivedMessages.some((m) => m.some((msg) => msg.severity === "info")), 5000);
  }, 10000);

  it("treats a plain content modification (same path) as an immediate check", async () => {
    writeFileSync(join(watchDir, "modified.js"), documentedSource);
    documentationService.writeDoc(watchDir, "modified.js", 0, documentedSource.length, "greets someone");
    await sleep(50);
    receivedMessages.length = 0;

    writeFileSync(join(watchDir, "modified.js"), `function greet(name) {\n  return "hi " + name;\n}\n`);

    await waitFor(
      () => receivedMessages.some((m) => m.some((msg) => msg.severity === "warning" || msg.severity === "error")),
      3000
    );

    // A plain content change touches exactly one file's identity -- a listener
    // needs this to know which file's previously-shown messages to replace,
    // even on a future event where the new message list happens to be empty.
    expect(receivedRelativePaths[receivedRelativePaths.length - 1]).toEqual(["modified.js"]);
  }, 10000);

  it("ignores non-source file changes entirely", async () => {
    writeFileSync(join(watchDir, "README.md"), "# hello\n");
    await sleep(CORRELATION_WINDOW_MS + 500);

    expect(receivedMessages).toEqual([]);
  }, 10000);

  // .mjs/.cjs/.mts/.cts (explicit ESM/CommonJS variants) are plain JS/TS
  // syntax-wise, and increasingly common (Vite/Node config files) -- these
  // were invisible to SOURCE_FILE_PATTERN entirely until this was added,
  // regardless of what the parser itself could already handle.
  it.each([".mjs", ".cjs", ".mts", ".cts"])(
    "recognizes a %s file as a real source file, not something to ignore",
    async (extension) => {
      writeFileSync(join(watchDir, `config${extension}`), `export const value = 1;\n`);
      await waitFor(() => receivedRelativePaths.length > 0, 3000);

      expect(receivedRelativePaths[receivedRelativePaths.length - 1]).toEqual([`config${extension}`]);
    },
    10000
  );

  // Real bug found via manual testing against a repo with a Python
  // virtualenv inside it: chokidar had no notion of gitignore at all and
  // walked/watched every one of its ~20,000 files anyway, which is what was
  // actually behind the whole window reporting as "Not Responding" while it
  // did so. A .gitignore has to exist BEFORE start() reads it (it's read
  // once, up front, not re-checked per event) -- restarting the watcher
  // here, mid-test, after writing it is what makes that order real rather
  // than assumed.
  it("never watches a gitignored directory's contents at all, not just filters them after the fact", async () => {
    writeFileSync(join(watchDir, ".gitignore"), "ignored_dir/\n");
    mkdirSync(join(watchDir, "ignored_dir"), { recursive: true });
    await liveWatchService.stop();
    await liveWatchService.start(watchDir, CORRELATION_WINDOW_MS);
    receivedMessages.length = 0;
    receivedRelativePaths.length = 0;

    writeFileSync(join(watchDir, "ignored_dir", "inside.js"), "export const value = 1;\n");
    // A file elsewhere, definitely NOT ignored, to prove the watcher is
    // genuinely running and would have reported the ignored one too if it
    // had seen it -- without this, "no messages arrived" could just as
    // easily mean the watcher silently isn't working at all.
    writeFileSync(join(watchDir, "visible.js"), "export const value = 2;\n");

    await waitFor(() => receivedRelativePaths.flat().includes("visible.js"), 3000);

    expect(receivedRelativePaths.flat()).not.toContain("ignored_dir/inside.js");
  }, 10000);

  // Real bug found via manual multi-collaborator testing: pulling a
  // teammate's newly-added documentation for code you already have,
  // UNCHANGED, only touches .rapid-docs/<path>.json on disk -- the source
  // file itself never changes. Before this fix, that left the Problems tab
  // showing a stale "no documentation yet" message indefinitely, since
  // nothing ever told the watcher anything relevant had happened.
  it("treats a documentation record appearing on its own (source file untouched) as a reason to recheck the source file", async () => {
    const undocumented = `function multiply(a, b) {\n  return a * b;\n}\n`;
    writeFileSync(join(watchDir, "maths.js"), undocumented);
    await sleep(500);
    receivedMessages.length = 0;
    receivedRelativePaths.length = 0;

    // Simulates exactly what `git pull` does when a collaborator's commit
    // only adds/updates the storage file -- writeDoc here never touches
    // maths.js on disk at all, only .rapid-docs/maths.js.json.
    documentationService.writeDoc(watchDir, "maths.js", 0, undocumented.length, "multiplies two numbers");

    await waitFor(() => receivedRelativePaths.some((paths) => paths.includes("maths.js")), 3000);

    const latestForMaths = receivedMessages[receivedRelativePaths.findIndex((p) => p.includes("maths.js"))];
    expect(latestForMaths.some((m) => m.severity === "info")).toBe(false);
  }, 10000);

  it("still ignores the repo-wide archive file -- it doesn't mirror any single source file", async () => {
    writeFileSync(join(watchDir, "unrelated.js"), documentedSource);
    await sleep(500);
    receivedMessages.length = 0;
    receivedRelativePaths.length = 0;

    mkdirSync(join(watchDir, ".rapid-docs"), { recursive: true });
    writeFileSync(join(watchDir, ".rapid-docs", "_archive.json"), "[]");

    await sleep(CORRELATION_WINDOW_MS + 500);

    expect(receivedRelativePaths).toEqual([]);
  }, 10000);

  it("also recognizes a documentation record disappearing on its own (e.g. a collaborator's delete arriving via pull)", async () => {
    const source = `function subtract(a, b) {\n  return a - b;\n}\n`;
    writeFileSync(join(watchDir, "sub.js"), source);
    documentationService.writeDoc(watchDir, "sub.js", 0, source.length, "subtracts two numbers");
    await sleep(500);
    receivedMessages.length = 0;
    receivedRelativePaths.length = 0;

    const storagePath = documentationService.storagePathFor(watchDir, "sub.js");
    unlinkSync(storagePath);

    await waitFor(() => receivedRelativePaths.some((paths) => paths.includes("sub.js")), 3000);

    const latestForSub = receivedMessages[receivedRelativePaths.findIndex((p) => p.includes("sub.js"))];
    expect(latestForSub.some((m) => m.severity === "info")).toBe(true);
  }, 10000);

  it("mirrors nested source directories, and normalizes the identity to forward slashes", async () => {
    const nestedDir = join(watchDir, "src", "nested");
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(nestedDir, "deep.js"), documentedSource);
    // Document it directly, keyed by the forward-slash identity writeDoc always uses.
    documentationService.writeDoc(watchDir, "src/nested/deep.js", 0, documentedSource.length, "greets someone");

    // Let chokidar register and cache the initial add before editing it live.
    await sleep(500);

    // If the watcher's absolute->relative conversion produced anything other
    // than "src/nested/deep.js" (e.g. backslashes on Windows), this edit would
    // be checked against a DIFFERENT identity than the one writeDoc used above,
    // and no drift would ever be detected here.
    writeFileSync(join(nestedDir, "deep.js"), `function greet(name) {\n  return "hi " + name;\n}\n`);

    await waitFor(
      () => receivedMessages.some((m) => m.some((msg) => msg.severity === "warning" || msg.severity === "error")),
      5000
    );
  }, 10000);

  it("correlates a rename/move even for a file that existed BEFORE the watcher started", async () => {
    // Real bug found manually: chokidar's ignoreInitial:true never fires "add"
    // for pre-existing files, so without an upfront cache-priming pass, a file
    // nobody has touched yet this session would have no cached content -- and
    // moving it would always look like a plain deletion, no matter how
    // identical the content actually is. Reproduces that exact scenario: stop
    // the already-running watcher from beforeEach, set up a file that already
    // exists and is already documented, THEN start watching it for the first
    // time, and move it without ever touching it live first.
    await liveWatchService.stop();

    mkdirSync(join(watchDir, "lib"), { recursive: true });
    writeFileSync(join(watchDir, "src.js"), documentedSource);
    documentationService.writeDoc(watchDir, "src.js", 0, documentedSource.length, "greets someone");
    git("add", "-A");
    git("commit", "-qm", "initial, already documented");

    await liveWatchService.start(watchDir, CORRELATION_WINDOW_MS);
    await sleep(500);

    renameSync(join(watchDir, "src.js"), join(watchDir, "lib", "moved.js"));

    await waitFor(
      () => existsSync(documentationService.storagePathFor(watchDir, "lib/moved.js")),
      CORRELATION_WINDOW_MS + 2000
    );

    expect(existsSync(documentationService.storagePathFor(watchDir, "src.js"))).toBe(false);
    expect(existsSync(documentationService.storagePathFor(watchDir, "lib/moved.js"))).toBe(true);

    // A rename touches TWO identities -- the old path (now gone entirely, so a
    // listener must clear it, not just leave its last-known messages showing
    // forever) and the new path (which gets whatever the fresh check found).
    expect(receivedRelativePaths[receivedRelativePaths.length - 1].sort()).toEqual(["lib/moved.js", "src.js"].sort());
  }, 10000);
});
