// A per-file "stop watching this file" toggle -- real user feedback,
// 2026-10-09: there was no way to tell rapid-docs to leave a specific file
// alone (no squiggly underlines, no Problems entries) short of closing the
// whole workspace or just tolerating the noise. Local-only (VSCode's own
// workspaceState, not .rapid-docs/ storage) deliberately: this is a
// personal viewing preference (e.g. muting a scratch file while recording
// a video), not something that should get committed and forced onto every
// collaborator who clones the repo.
//
// Decoupled from vscode.ExtensionContext/vscode.Memento by design, not just
// for testing: ExclusionStore only needs the two methods Memento already
// has, so context.workspaceState can be passed in directly with no adapter,
// while a plain in-memory object stands in for it in tests with no VSCode
// dependency (and no VSCode test harness) needed at all.
export interface ExclusionStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

const KEY_PREFIX = "rapidDocs.excludedFiles";

function keyFor(repoPath: string): string {
  return `${KEY_PREFIX}:${repoPath}`;
}

export function isExcluded(store: ExclusionStore, repoPath: string, relativePath: string): boolean {
  const excluded = store.get<string[]>(keyFor(repoPath), []);
  return excluded.includes(relativePath);
}

// Returns the resulting state (true = now excluded), so the caller can show
// the right confirmation/relabel without a second isExcluded lookup.
export async function toggleExclusion(store: ExclusionStore, repoPath: string, relativePath: string): Promise<boolean> {
  const key = keyFor(repoPath);
  const excluded = store.get<string[]>(key, []);
  const alreadyExcluded = excluded.includes(relativePath);
  const next = alreadyExcluded ? excluded.filter((path) => path !== relativePath) : [...excluded, relativePath];
  await store.update(key, next);
  return !alreadyExcluded;
}
