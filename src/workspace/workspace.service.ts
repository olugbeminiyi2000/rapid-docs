import { Injectable } from "@nestjs/common";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { listRecentRepos, recordRecentRepoDeduped } from "./recent-repos.js";

interface Preferences {
  lastRepoPath?: string;
  // recentRepos/recentReposIndex together are the circular buffer's whole
  // on-disk state -- both must be saved together, every time, or the
  // rotation position (recentReposIndex) desyncs from the array on restart.
  recentRepos?: string[];
  recentReposIndex?: number;
}

const PREFERENCES_FILENAME = "preferences.json";

// The list is meant to mirror a picker UI (see the Workspaces list in
// VSCode/Antigravity's own "open folder" screen) -- 15 is plenty to
// recognize a project by without turning into an unscannable wall.
const MAX_RECENT_REPOS = 15;

// Deliberately takes userDataDir as an explicit parameter, never hardcoded --
// the same reason DocumentationService moved away from a fixed "storage/"
// path. In the real app this is Electron's app.getPath("userData"), but this
// service has no Electron dependency at all, so it stays testable under plain
// Jest without ever needing the real Electron module resolved.
@Injectable()
export class WorkspaceService {
  getLastRepoPath(userDataDir: string): string | null {
    const prefs = this.loadPreferences(userDataDir);
    return prefs.lastRepoPath ?? null;
  }

  setLastRepoPath(userDataDir: string, repoPath: string): void {
    const prefs = this.loadPreferences(userDataDir);
    prefs.lastRepoPath = repoPath;
    this.savePreferences(userDataDir, prefs);
  }

  // Explicitly forgetting the repo is a different action from ever having
  // set one -- without this, there was no way to make the app NOT
  // auto-reopen the last repo on next launch, only ways to replace it with
  // a different one. Matches "Close Folder" in editors like VSCode: closing
  // is remembered too, not just opening.
  clearLastRepoPath(userDataDir: string): void {
    const prefs = this.loadPreferences(userDataDir);
    delete prefs.lastRepoPath;
    this.savePreferences(userDataDir, prefs);
  }

  // Called whenever the user explicitly opens or switches to a repo (never
  // on the silent, no-dialog auto-reopen of lastRepoPath at launch -- that's
  // not a new "choice," so recording it again would just be a pointless
  // disk write with de-dup already keeping it in first place regardless).
  recordOpenedRepo(userDataDir: string, repoPath: string): void {
    const prefs = this.loadPreferences(userDataDir);
    const { repoArray, persistenceIndex } = recordRecentRepoDeduped(
      repoPath,
      prefs.recentRepos ?? [],
      prefs.recentReposIndex ?? 0,
      MAX_RECENT_REPOS
    );
    prefs.recentRepos = repoArray;
    prefs.recentReposIndex = persistenceIndex;
    this.savePreferences(userDataDir, prefs);
  }

  listOpenedRepos(userDataDir: string): string[] {
    const prefs = this.loadPreferences(userDataDir);
    return listRecentRepos(prefs.recentRepos ?? [], prefs.recentReposIndex ?? 0);
  }

  private preferencesPathFor(userDataDir: string): string {
    return join(userDataDir, PREFERENCES_FILENAME);
  }

  private loadPreferences(userDataDir: string): Preferences {
    const path = this.preferencesPathFor(userDataDir);

    if (!existsSync(path)) {
      return {};
    }

    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as Preferences;
  }

  private savePreferences(userDataDir: string, prefs: Preferences): void {
    if (!existsSync(userDataDir)) {
      mkdirSync(userDataDir, { recursive: true });
    }

    writeFileSync(this.preferencesPathFor(userDataDir), JSON.stringify(prefs, null, 2));
  }
}
