import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WorkspaceService } from "./workspace.service.js";

describe("WorkspaceService", () => {
  let workspaceService: WorkspaceService;
  let userDataDir: string;

  beforeEach(() => {
    workspaceService = new WorkspaceService();
    userDataDir = mkdtempSync(join(tmpdir(), "workspace-service-test-"));
  });

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true });
  });

  describe("getLastRepoPath", () => {
    it("returns null when nothing has ever been saved", () => {
      expect(workspaceService.getLastRepoPath(userDataDir)).toBeNull();
    });
  });

  describe("setLastRepoPath / getLastRepoPath", () => {
    it("persists and retrieves a chosen repo path", () => {
      workspaceService.setLastRepoPath(userDataDir, "C:/Users/alice/my-project");

      expect(workspaceService.getLastRepoPath(userDataDir)).toBe("C:/Users/alice/my-project");
    });

    it("overwrites a previously saved path rather than merging with it", () => {
      workspaceService.setLastRepoPath(userDataDir, "C:/Users/alice/first-project");
      workspaceService.setLastRepoPath(userDataDir, "C:/Users/alice/second-project");

      expect(workspaceService.getLastRepoPath(userDataDir)).toBe("C:/Users/alice/second-project");
    });

    it("creates userDataDir if it doesn't exist yet", () => {
      rmSync(userDataDir, { recursive: true, force: true });
      expect(existsSync(userDataDir)).toBe(false);

      workspaceService.setLastRepoPath(userDataDir, "C:/Users/alice/my-project");

      expect(existsSync(userDataDir)).toBe(true);
      expect(workspaceService.getLastRepoPath(userDataDir)).toBe("C:/Users/alice/my-project");
    });
  });

  describe("clearLastRepoPath", () => {
    it("makes getLastRepoPath return null again after a repo was set", () => {
      workspaceService.setLastRepoPath(userDataDir, "C:/Users/alice/my-project");
      workspaceService.clearLastRepoPath(userDataDir);

      expect(workspaceService.getLastRepoPath(userDataDir)).toBeNull();
    });

    it("does nothing harmful when nothing was ever set", () => {
      expect(() => workspaceService.clearLastRepoPath(userDataDir)).not.toThrow();
      expect(workspaceService.getLastRepoPath(userDataDir)).toBeNull();
    });
  });

  describe("recordOpenedRepo / listOpenedRepos", () => {
    it("returns an empty list when nothing has ever been opened", () => {
      expect(workspaceService.listOpenedRepos(userDataDir)).toEqual([]);
    });

    it("lists opened repos newest-first", () => {
      workspaceService.recordOpenedRepo(userDataDir, "C:/repos/first");
      workspaceService.recordOpenedRepo(userDataDir, "C:/repos/second");

      expect(workspaceService.listOpenedRepos(userDataDir)).toEqual(["C:/repos/second", "C:/repos/first"]);
    });

    it("moves a reopened repo to the front instead of listing it twice", () => {
      workspaceService.recordOpenedRepo(userDataDir, "C:/repos/first");
      workspaceService.recordOpenedRepo(userDataDir, "C:/repos/second");
      workspaceService.recordOpenedRepo(userDataDir, "C:/repos/first");

      expect(workspaceService.listOpenedRepos(userDataDir)).toEqual(["C:/repos/first", "C:/repos/second"]);
    });

    // The whole reason recordRecentRepo's rotation index has to be persisted
    // (not just the array): a fresh WorkspaceService instance here has no
    // in-memory state at all, only whatever recordOpenedRepo already wrote
    // to preferences.json -- this is the real cross-restart scenario, not a
    // simulation of one.
    it("survives across separate WorkspaceService instances, like an app restart", () => {
      workspaceService.recordOpenedRepo(userDataDir, "C:/repos/first");
      workspaceService.recordOpenedRepo(userDataDir, "C:/repos/second");

      const afterRestart = new WorkspaceService();
      expect(afterRestart.listOpenedRepos(userDataDir)).toEqual(["C:/repos/second", "C:/repos/first"]);
    });

    it("coexists with lastRepoPath in the same preferences file without either clobbering the other", () => {
      workspaceService.setLastRepoPath(userDataDir, "C:/repos/active");
      workspaceService.recordOpenedRepo(userDataDir, "C:/repos/first");
      workspaceService.recordOpenedRepo(userDataDir, "C:/repos/second");

      expect(workspaceService.getLastRepoPath(userDataDir)).toBe("C:/repos/active");
      expect(workspaceService.listOpenedRepos(userDataDir)).toEqual(["C:/repos/second", "C:/repos/first"]);
    });
  });
});
