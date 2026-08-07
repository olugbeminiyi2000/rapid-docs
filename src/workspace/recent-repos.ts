// A fixed-capacity, most-recently-used list of repo paths, backed by a
// circular buffer -- deliberately plain functions taking every piece of
// state as an explicit parameter (no class, no hidden state), so this stays
// trivially testable on its own before anything wires it up to real
// persistence (WorkspaceService/preferences.json).
//
// persistenceIndex always points at the OLDEST slot -- the next one due to
// be overwritten. Below capacity, a new repo is simply appended and
// persistenceIndex stays put; rotation only begins once the buffer is
// genuinely full. Every value recordRecentRepo returns must be persisted by
// the caller, alongside repoArray itself, or the rotation position is lost
// across a restart.

export function recordRecentRepo(
  newRepo: string,
  repoArray: string[],
  persistenceIndex: number,
  maxRepos: number
): number {
  if (repoArray.length < maxRepos) {
    repoArray.push(newRepo);
    return persistenceIndex;
  }

  repoArray[persistenceIndex] = newRepo;
  const nextIndex = persistenceIndex + 1;
  return nextIndex === maxRepos ? 0 : nextIndex;
}

// Reads the buffer back out newest-first. maxRepos isn't needed here at all
// -- recordRecentRepo never lets repoArray grow past it, so repoArray.length
// alone is always the correct bound, full or not.
//
// JavaScript array indexing doesn't wrap negative indices the way Python's
// does, so the wraparound here is explicit: a bare `idx % len` leaves a
// negative idx negative in JS (unlike Python's modulo), so this adds len
// back before taking the modulo a second time to land in [0, len) either way.
export function listRecentRepos(repoArray: string[], persistenceIndex: number): string[] {
  const displayed: string[] = [];

  for (let step = 0; step < repoArray.length; step++) {
    const idx = persistenceIndex - 1 - step;
    const wrapped = ((idx % repoArray.length) + repoArray.length) % repoArray.length;
    displayed.push(repoArray[wrapped]);
  }

  return displayed;
}

// The real-world-correct entry point: reopening a repo that's already in
// the list moves it to the front instead of rotating in a second, duplicate
// entry -- otherwise bouncing between the same 2 repos would slowly fill
// every slot with copies of just those 2, wasting the whole point of a
// 15-entry list.
//
// Splicing the duplicate out of repoArray directly and calling
// recordRecentRepo would be wrong: the ring buffer's whole invariant is
// that persistenceIndex's DISTANCE from a slot (not the slot's raw index)
// encodes its age, and removing an element from the middle shifts every
// later element left by one, silently desyncing persistenceIndex from what
// it's supposed to point at. Rebuilding from scratch sidesteps that
// entirely: read the correct final MRU order out with the already-proven
// listRecentRepos, then replay it oldest-to-newest through the
// already-proven recordRecentRepo against a fresh empty buffer -- no new,
// separately-reasoned-about mutation logic, just composition of the two
// primitives already verified above.
export function recordRecentRepoDeduped(
  newRepo: string,
  repoArray: string[],
  persistenceIndex: number,
  maxRepos: number
): { repoArray: string[]; persistenceIndex: number } {
  const newestFirst = [newRepo, ...listRecentRepos(repoArray, persistenceIndex).filter((repo) => repo !== newRepo)];
  const cappedNewestFirst = newestFirst.slice(0, maxRepos);
  const oldestFirst = cappedNewestFirst.slice().reverse();

  const freshRepoArray: string[] = [];
  let freshIndex = 0;
  for (const repo of oldestFirst) {
    freshIndex = recordRecentRepo(repo, freshRepoArray, freshIndex, maxRepos);
  }

  return { repoArray: freshRepoArray, persistenceIndex: freshIndex };
}
