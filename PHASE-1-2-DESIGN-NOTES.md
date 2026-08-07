# rapid-docs — Phase 1 & 2 Design Notes

Purpose of this document: a record of *why* each design decision in the core engine was made — the original idea, what testing or reasoning challenged it, how it was refined, and how it was verified. Written for later use in an article/write-up about the correctness and efficiency thinking behind the build, not as user-facing documentation.

---

## Phase 1 — Decoding the AST

### 1. Parser choice: `@babel/parser`
**Original question:** which parser to learn on.
**Reasoning:** compared against Acorn (JS-only by default), the TypeScript Compiler API (authoritative for TS, but numeric `kind` enums instead of readable `type` strings — harder to learn from), and tree-sitter (built for editors/incremental parsing, heavier setup).
**Decision:** `@babel/parser` — human-readable `type` strings, JS+JSX+TS in one tool, and the same parser underlying Prettier and most codemod tooling.

### 2. Node anatomy: half-open intervals
**Original question:** what do `start`/`end`/`loc` actually mean, and are they redundant?
**Finding:** `start`/`end` (top-level, 0-indexed) and `loc.start.index`/`loc.end.index` are literally the same number, duplicated for convenience. `loc.line`/`loc.column` are the same offset translated into human/editor terms by counting newlines.
**Verification:** `code.slice(node.start, node.end)` was run against several real nodes and reproduced their exact source text every time — direct proof of the `[start, end)` half-open convention, and that `end - start` always equals the node's exact length.

### 3. Generic node-detection instead of per-type knowledge
**Original problem:** TypeScript's grammar has 248 node types (verified later via Babel's own registry) — impossible to hand-enumerate what each one's children look like.
**Decision:** one universal rule — "if a value has a `type` field, it's a child node; recurse into any object/array, ignore everything else" — rather than a lookup table keyed by node type.
**Why this matters (correctness + maintainability):** works identically for every node type that exists today *and* any TypeScript/JS syntax added in the future, with zero code changes required.

### 4. Highlight matching: "contained within" instead of "closest enclosing"
**Original design (first considered):** collapse a messy highlight to the single closest node that fully *contains* it.
**Refinement:** rethinking what documentation is actually *for* (attaching to, and later hashing, a set of nodes) led to flipping the relationship — collect every node *contained within* the highlight, not the one node containing it. A highlight spanning a pre-existing comment plus the function below it, for example, only works under this direction, since no single node's own range spans both.
**Decision:** "contained within" is the correct primitive; "closest enclosing" was the wrong direction for what documentation needed.

### 5. Position can never be used for identity — only for locating in the *current* tree
**Established early, reinforced throughout:** `start`/`end`/`line`/`column` are only meaningful within one parse of one version of a file. Any two parses of edited code have incompatible coordinate systems. This became the single governing constraint behind every later storage and hashing decision.

### 6. The generic tree-walker: correctness bug found, then an efficiency redesign
**Correctness:** first version (user-written pseudocode) declared its accumulator array fresh inside the function on every recursive call, and never merged a child call's results back into the parent's. Run against real input, it silently returned an empty result — diagnosed by reasoning through what happens to a nested call's local array once the call returns.
**Fix #1 (correctness):** merge-on-return — capture each recursive call's return value and fold it into the caller's own array.
**Efficiency problem found:** merge-on-return re-copies a node's content once per ancestor level as it propagates upward — `O(N × depth)`, not `O(N)`.
**Fix #2 (efficiency, without losing correctness):** switch to a default-parameter accumulator (`function walk(node, ..., resultMap = new Map())`), passed by reference through recursive calls. Every top-level call gets a fresh, empty accumulator automatically (no caller-managed reset, no risk of stale state leaking across calls), while internal recursion never copies — true `O(N)`.

### 7. Deduplication key: `(type, start, end)`, not `(start, end)` alone
**Found through testing, not assumption:** two *different* node types can share an identical range when no extra character separates them (e.g. `File`/`Program` sharing the whole file's span; an `ExpressionStatement` wrapping a bare identifier with no semicolon). Using only `(start, end)` as a dedup key would have wrongly conflated these.
**Why `(type, start, end)` is safe:** a parent and child sharing a range always have *different* type labels by construction — no case found (or theoretically expected) where two genuinely distinct nodes share both type and range.
**Verification — two real, distinct duplicate bugs found and correctly deduplicated:**
- Babel cross-attaches the same comment object as both `trailingComments` of one statement and `leadingComments` of the next — found via a deliberate `test-comments.js` case, confirmed as a genuine duplicate (identical type *and* range).
- Shorthand object/destructuring properties (`{ first }`) give the `ObjectProperty`'s `key` and `value` two separate `Identifier` objects at the identical position — found via `test-rich-syntax.js`, confirmed the same way.

### 8. TypeScript conversion — typed where knowledge exists, `unknown` where it genuinely doesn't
**Reasoning:** `@babel/types` ships real, generated type definitions for every node shape — directly solves "how do we know what TypeScript's grammar offers" without guessing.
**Honest typing choice:** the generic walker is inherently dynamic (inspects shape at runtime by design) — typed its input as `unknown` with explicit narrowing checks, rather than falsely claiming a specific shape it doesn't actually have in advance.

### 9. Crash safety: `errorRecovery` + `try/catch`
**Found by deliberate testing:** feeding real TypeScript syntax through a parser call with no plugin enabled threw an uncaught exception and killed the whole process.
**Fix, matching real-world tools (ESLint, Prettier, tsc, language servers):** `errorRecovery: true` lets Babel continue past recoverable mistakes and report them in `ast.errors` instead of throwing; a `try/catch` backstop catches the remaining genuinely fatal cases. Neither the process nor the caller ever crashes — every run returns structured data (`{ types, errors, fatal }`), even for bad input.

### 10. Enabling the TypeScript plugin
Root-caused the crash above to the parser simply not understanding TS syntax without `plugins: ["typescript"]`. Enabled it everywhere source gets parsed; re-ran all existing test cases to confirm zero regressions before considering it done.

### 11. Objective 1.3 — structural fingerprinting
**Core correctness question:** what data should feed a hash so it reflects real structural change, not surface noise?
- Distinguished a literal's semantic `value` (Babel's already-normalized interpretation, e.g. `5`) from `extra.raw` (surface text, e.g. `"5"` vs `"5.0"` vs `"0x5"`, or `'x'` vs `"x"`) — decided to hash `value`, never `extra`, since reformatting a literal shouldn't count as a structural change.
- Rather than hand-classifying 248 node types' fields, **researched Babel's own authoritative `NODE_FIELDS`/`VISITOR_KEYS` registries** to get an evidence-based answer instead of a guess: of 49 distinct leaf-field names across the whole grammar, only two (`tokens`, `expectedNode`) are pure parser bookkeeping — everything else (`kind`, `operator`, `static`, `async`, `prefix`, `pattern`, `flags`, etc.) is genuinely semantic. This also surfaced a real gap in trusting `VISITOR_KEYS` alone for traversal (a `File` node's `comments` field is classified as a leaf, not a child) — kept the existing generic duck-typing walk as the traversal method, using the field research only to decide what counts as hashable data.
- Deliberately decided identifier **names count** toward the hash (a rename is treated as a real structural change) — an explicit product judgment call, not a forced technical answer.
- Built the hash on Node's built-in SHA-256 rather than a hand-rolled function — reasoned explicitly that a hash function's collision-resistance and avalanche-effect properties require deep, adversarially-tested cryptographic design; reusing a standard gets decades of expert scrutiny for free, where a custom function would quietly undermine the entire "same hash implies same code" guarantee the system depends on.
**Verification, not just claims:**
- A whitespace-only edit (blank lines, re-indentation) produced an *identical* hash set to the original — direct proof of position-invariance.
- A rename (`message` → `msg`) changed exactly 7 of 18 distinct hashes: the renamed node and every real ancestor containing it, and *nothing* unrelated (a sibling `const x = 10`, a `StringLiteral`, the `BinaryExpression` itself) — proving both invariance and correct upward propagation with real data.
**Known, deliberately deferred inefficiency:** the hash embeds a child's full canonical *text* into its parent's string rather than combining pre-computed child *hashes* — causing `O(N × depth)` redundant re-serialization for deeply nested subtrees. Identified as the same category of problem the roadmap's Merkle-tree objective (Phase 4.2) exists to solve, and explicitly left alone rather than prematurely optimized, since it's negligible at single-file scale.

---

## Phase 2 — Detecting State & Drift

### 12. Objective 2.1 — proven directly
The whitespace-invariance test above *is* the proof for this objective: node identity survives arbitrary position shifts, confirmed with real data before Phase 2 was formally reached.

### 13. Objective 2.2 — structural change detection, storage, and alerting

**Refactor for maintainability:** split one large function into single-purpose files (`parse-source.ts`, `walk-tree.ts`, `filter-by-highlight.ts`, `hash-node.ts`, orchestrated by `run-walk.ts`) — each independently testable and debuggable. Verified byte-for-byte identical behavior before and after the split.

**Storage scoped per file, not per project (efficiency):** one JSON storage file per source file, rather than one project-wide store — bounds both disk I/O and in-memory reverse-index-building cost to only the file actually being worked on.

**Forward map + derived (never persisted) reverse index (correctness):** `recordId → record` is the one persisted source of truth; `hash → recordId` is rebuilt fresh in memory every time from that source. Chosen specifically to avoid two independently-saved copies of related data ever drifting out of sync — and this same choice turned out, as a discovered side benefit rather than an upfront plan, to make future record deletion free of any index-cleanup work.

**Documentation text never touches hashing (correctness):** verified by tracing the actual code path — `HASH_AST_NODE` only ever receives raw AST nodes; `docText` is stored as a fully separate field. Critical, because otherwise simply rewording your own documentation would falsely register as "the code changed."

**Rejected an initially-proposed "auto re-sync a stale record" feature:** worked through the concrete cases (a `fully_stale` record has nothing left to anchor a new position to; a `partially_stale` record has no stored position at all — only `{type, hash}` — so there's no way to mechanically know the new correct boundary when code was added, removed, or overlapping). Concluded the operation has no well-defined, computable answer, and dropped it — the correct resolution is: alert the human (already built), let them re-highlight fresh (already built via `WRITE_DOC`) or delete the stale record. A feature that sounded reasonable in words turned out not to have a real implementation, and removing it was the right call rather than forcing something ambiguous.

**`recordId` changed from an arbitrary counter to a hash of the sorted member hashes:** the same exact highlight now always produces the same ID, so "is this already documented" becomes a single `Map` lookup instead of a separate detection mechanism — `WRITE_DOC` refuses outright on a duplicate rather than silently overwriting. Explicit scope decision: one unique node-set maps to exactly one documentation entry, not many.

**Drift-check walks the current file exactly once (efficiency):** one fresh hash `Set`, reused to check every stored record, rather than re-walking/re-parsing per record.

**Per-member hashes stored, not one combined hash for the group (a deliberate precision-over-storage tradeoff):** enables reporting *which specific part* of a documented group changed, not just a blunt yes/no.

**Combined drift-check + undocumented-code detection into one function (`CHECK_FILE`), retiring the standalone version (efficiency):** avoids walking/parsing the same file twice for two closely related questions.
**Verified subtlety, not a bug:** code edited *inside* a documented region correctly appears in *both* reports simultaneously — stale on the old record, and undocumented as new content — because both facts are independently, simultaneously true.

**Message generation — same genericity lesson applied a third time:** rejected a hardcoded "friendly name" translation table for node types (the same lesson as the generic walker and the field-registry research) in favor of raw type names — scales to every type with zero maintenance, and is arguably *more* appropriate for the intended audience (programmers already fluent in AST terminology). Also tested and rejected an auto-formatting idea (inserting spaces before capitals) after finding a concrete failure case: `TSTypeAliasDeclaration` becomes the awkward `T S Type Alias Declaration` — a good example of checking an idea against a real case rather than accepting it on first impression.
**Undocumented-node reporting:** collapses nested duplicates to only the outermost affected node, reusing the exact containment-check pattern from the highlight-matching work in Phase 1.
**Stale-member reporting:** honestly limited by what's actually stored (`{type, hash}` only, no position) — the same containment-collapse trick used for undocumented nodes can't apply here, so it reports a deduplicated, capped list of distinct changed types instead of pretending a precision the data doesn't support.

---

## Recurring patterns across both phases (the throughline for the write-up)

1. **Genericity over hardcoding, applied three separate times** — the type-field walker, deciding what belongs in a hash, and generating messages all independently rejected a per-case lookup table in favor of one rule that scales to anything, including things that don't exist yet.
2. **Evidence over assumption** — the dedup key, the hash-field decision, and the field-registry research were all settled by looking at real Babel output or running real test cases, not by reasoning alone.
3. **Test before trusting a design** — every fix (the recursion bug, the crash, the duplicate nodes, the whitespace/rename hash behavior) was verified by actually running code against real input before being accepted.
4. **Honest tradeoff acknowledgment instead of silent compromise** — the Merkle-tree-scoped hashing inefficiency and the position-free stale-member limitation were both named explicitly and left as deliberate, documented decisions rather than glossed over.
5. **Correctly killing a feature that doesn't have a real answer** — the "re-sync" idea was reasoned through fully before being rejected, rather than built anyway and discovered broken later.
