import { recordRecentRepo, listRecentRepos, recordRecentRepoDeduped } from "./recent-repos.js";

describe("recordRecentRepo / listRecentRepos", () => {
  describe("below capacity", () => {
    it("appends without rotating, and persistenceIndex stays put", () => {
      const repoArray: string[] = [];
      let index = 0;

      index = recordRecentRepo("a", repoArray, index, 3);
      expect(repoArray).toEqual(["a"]);
      expect(index).toBe(0);

      index = recordRecentRepo("b", repoArray, index, 3);
      expect(repoArray).toEqual(["a", "b"]);
      expect(index).toBe(0);
    });

    it("lists newest-first, without needing to reach capacity first", () => {
      const repoArray = ["a", "b"];
      expect(listRecentRepos(repoArray, 0)).toEqual(["b", "a"]);
    });

    it("returns an empty list for an empty array, without throwing", () => {
      expect(listRecentRepos([], 0)).toEqual([]);
    });
  });

  describe("at capacity", () => {
    it("still lists newest-first once exactly full", () => {
      const repoArray = ["a", "b", "c"];
      expect(listRecentRepos(repoArray, 0)).toEqual(["c", "b", "a"]);
    });

    it("starts overwriting the oldest slot, and advances persistenceIndex", () => {
      const repoArray = ["a", "b", "c"];
      const index = recordRecentRepo("d", repoArray, 0, 3);

      expect(repoArray).toEqual(["d", "b", "c"]);
      expect(index).toBe(1);
      expect(listRecentRepos(repoArray, index)).toEqual(["d", "c", "b"]);
    });
  });

  describe("real evidence: two full wraparound cycles from an empty buffer", () => {
    // Every intermediate value here was verified by actually running the
    // real compiled implementation first (a-through-i, maxRepos=3), not
    // hand-derived -- this test locks in exactly what was observed, so a
    // future change that silently breaks the rotation math fails here.
    it("evicts oldest-first and produces correct MRU order at every step across two full cycles", () => {
      const maxRepos = 3;
      const repoArray: string[] = [];
      let index = 0;

      const record = (repo: string) => {
        index = recordRecentRepo(repo, repoArray, index, maxRepos);
      };

      record("a");
      record("b");
      record("c"); // now full
      expect(repoArray).toEqual(["a", "b", "c"]);
      expect(index).toBe(0);
      expect(listRecentRepos(repoArray, index)).toEqual(["c", "b", "a"]);

      record("d"); // evicts a
      expect(repoArray).toEqual(["d", "b", "c"]);
      expect(index).toBe(1);
      expect(listRecentRepos(repoArray, index)).toEqual(["d", "c", "b"]);

      record("e"); // evicts b
      expect(repoArray).toEqual(["d", "e", "c"]);
      expect(index).toBe(2);
      expect(listRecentRepos(repoArray, index)).toEqual(["e", "d", "c"]);

      record("f"); // evicts c -- first full wraparound complete, index back to 0
      expect(repoArray).toEqual(["d", "e", "f"]);
      expect(index).toBe(0);
      expect(listRecentRepos(repoArray, index)).toEqual(["f", "e", "d"]);

      record("g"); // second cycle begins, evicts d
      expect(repoArray).toEqual(["g", "e", "f"]);
      expect(index).toBe(1);
      expect(listRecentRepos(repoArray, index)).toEqual(["g", "f", "e"]);

      record("h"); // evicts e
      expect(repoArray).toEqual(["g", "h", "f"]);
      expect(index).toBe(2);
      expect(listRecentRepos(repoArray, index)).toEqual(["h", "g", "f"]);

      record("i"); // evicts f -- second full wraparound complete, index back to 0 again
      expect(repoArray).toEqual(["g", "h", "i"]);
      expect(index).toBe(0);
      expect(listRecentRepos(repoArray, index)).toEqual(["i", "h", "g"]);
    });
  });
});

describe("recordRecentRepoDeduped", () => {
  const step = (state: { repoArray: string[]; persistenceIndex: number }, repo: string, maxRepos: number) =>
    recordRecentRepoDeduped(repo, state.repoArray, state.persistenceIndex, maxRepos);

  it("behaves like the plain version for genuinely new repos, no duplicates involved", () => {
    let state = { repoArray: [] as string[], persistenceIndex: 0 };
    state = step(state, "a", 3);
    state = step(state, "b", 3);
    state = step(state, "c", 3);

    expect(listRecentRepos(state.repoArray, state.persistenceIndex)).toEqual(["c", "b", "a"]);
  });

  it("moves an already-listed repo to the front instead of duplicating it", () => {
    let state = { repoArray: [] as string[], persistenceIndex: 0 };
    state = step(state, "a", 3);
    state = step(state, "b", 3);
    state = step(state, "c", 3);

    state = step(state, "b", 3); // reopening b, already in the list

    expect(state.repoArray).toHaveLength(3); // still 3 distinct entries, not 4
    expect(listRecentRepos(state.repoArray, state.persistenceIndex)).toEqual(["b", "c", "a"]);
  });

  it("never accumulates duplicates no matter how many times the same 2 repos are bounced between", () => {
    // Real evidence: every intermediate value here was observed by actually
    // running the implementation first, not hand-derived.
    let state = { repoArray: [] as string[], persistenceIndex: 0 };
    state = step(state, "a", 3);
    state = step(state, "b", 3);
    state = step(state, "c", 3);

    for (const repo of ["b", "a", "b", "a", "b"]) {
      state = step(state, repo, 3);
      expect(state.repoArray).toHaveLength(3);
      expect(new Set(state.repoArray).size).toBe(3); // always 3 DISTINCT repos, never a duplicate
    }

    expect(listRecentRepos(state.repoArray, state.persistenceIndex)).toEqual(["b", "a", "c"]);
  });

  it("evicts the true least-recently-touched repo, not just whatever sits at array index 0", () => {
    // c is added once and never touched again, while a and b get bounced
    // repeatedly -- c is the real oldest by usage, even though de-dup
    // rebuilds mean its physical array position isn't a reliable proxy for
    // that on its own.
    let state = { repoArray: [] as string[], persistenceIndex: 0 };
    state = step(state, "a", 3);
    state = step(state, "b", 3);
    state = step(state, "c", 3);
    state = step(state, "b", 3);
    state = step(state, "a", 3);
    state = step(state, "b", 3);
    state = step(state, "a", 3);
    state = step(state, "b", 3);

    state = step(state, "d", 3); // a genuinely new repo -- must evict c, not a or b

    expect(listRecentRepos(state.repoArray, state.persistenceIndex)).toEqual(["d", "b", "a"]);
    expect(state.repoArray).not.toContain("c");
  });

  it("still correctly promotes a reopened repo to the front once persistenceIndex has genuinely rotated", () => {
    // A naive "splice the duplicate out, then call recordRecentRepo" was
    // tried and found wrong here specifically: once persistenceIndex is
    // non-zero (a REAL rotation already happened, not just a de-dup
    // rebuild), splicing a duplicate out of a full array drops it below
    // capacity, so recordRecentRepo takes its "append" branch and returns
    // persistenceIndex UNCHANGED -- for this exact array/index combination
    // that silently reconstructs the IDENTICAL array and index as before,
    // so reopening "c" produced no change at all, and the MRU order never
    // promoted it. Confirmed by actually running that version first.
    const initial = recordRecentRepo("d", ["a", "b", "c"], 0, 3); // genuine rotation: d evicts a
    const rotated = { repoArray: ["d", "b", "c"], persistenceIndex: initial };
    expect(listRecentRepos(rotated.repoArray, rotated.persistenceIndex)).toEqual(["d", "c", "b"]);

    const result = recordRecentRepoDeduped("c", rotated.repoArray, rotated.persistenceIndex, 3);

    expect(listRecentRepos(result.repoArray, result.persistenceIndex)).toEqual(["c", "d", "b"]);
  });
});
