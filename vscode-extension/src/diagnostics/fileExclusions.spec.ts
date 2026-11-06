import { isExcluded, toggleExclusion, type ExclusionStore } from "./fileExclusions";

function createFakeStore(): ExclusionStore {
  const data = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue: T): T {
      return (data.has(key) ? data.get(key) : defaultValue) as T;
    },
    update(key: string, value: unknown): Promise<void> {
      data.set(key, value);
      return Promise.resolve();
    },
  };
}

describe("fileExclusions", () => {
  it("reports a file as not excluded when it was never toggled", () => {
    const store = createFakeStore();
    expect(isExcluded(store, "/repo", "src/math.ts")).toBe(false);
  });

  it("excludes a file on the first toggle", async () => {
    const store = createFakeStore();
    const nowExcluded = await toggleExclusion(store, "/repo", "src/math.ts");
    expect(nowExcluded).toBe(true);
    expect(isExcluded(store, "/repo", "src/math.ts")).toBe(true);
  });

  it("re-includes a file on the second toggle", async () => {
    const store = createFakeStore();
    await toggleExclusion(store, "/repo", "src/math.ts");
    const nowExcluded = await toggleExclusion(store, "/repo", "src/math.ts");
    expect(nowExcluded).toBe(false);
    expect(isExcluded(store, "/repo", "src/math.ts")).toBe(false);
  });

  it("keeps exclusions scoped per repo, not global", async () => {
    const store = createFakeStore();
    await toggleExclusion(store, "/repoA", "src/math.ts");
    expect(isExcluded(store, "/repoA", "src/math.ts")).toBe(true);
    expect(isExcluded(store, "/repoB", "src/math.ts")).toBe(false);
  });

  it("does not affect other files in the same repo", async () => {
    const store = createFakeStore();
    await toggleExclusion(store, "/repo", "src/math.ts");
    expect(isExcluded(store, "/repo", "src/other.ts")).toBe(false);
  });
});
