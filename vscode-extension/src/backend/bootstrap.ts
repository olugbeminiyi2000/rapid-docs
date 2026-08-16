import { NestFactory } from "@nestjs/core";
// Compiled dist/*.js, not raw src/*.ts -- real finding 2026-08-16, confirmed
// via an isolated minimal reproduction, not assumed: esbuild correctly
// APPLIES legacy decorators (@Injectable() itself gets transpiled fine), but
// does not implement TypeScript's emitDecoratorMetadata AT ALL -- a real,
// long-standing, deliberate limitation of esbuild itself (esbuild's own
// maintainer has publicly declined to add best-effort support, citing
// correctness concerns from not being a real type checker), not a tsconfig
// or build-option mistake. Without design:paramtypes metadata, NestJS's
// constructor-based DI has nothing to resolve dependencies from, and every
// injected constructor parameter silently comes back undefined -- confirmed
// live: "Cannot read properties of undefined (reading 'getHeadCommit')" on
// activation, traced to SyncService.gitService never actually being set.
// tsc (via the root project's own existing `npm run build`) DOES emit this
// metadata correctly, so it's what actually transforms these decorator-heavy
// files -- esbuild.js then bundles the ALREADY-COMPILED JS output below, a
// plain static import of valid JS with no TS-specific transform needed at
// all, which is a completely different thing from the OLD, now-removed
// dynamic import() of this same dist/ output: that was a workaround for a
// CommonJS/ESM boundary at RUNTIME, in a version of this file that never got
// bundled at all. This one gets fully inlined into dist/extension.js at
// BUILD time, so the packaged extension has no separate dist/ dependency
// left over either way -- both original problems (no metadata under esbuild,
// no self-contained package) stay fixed at once.
import { AppModule } from "../../../dist/app.module.js";
import { GitService as GitServiceCtor } from "../../../dist/git/git.service.js";
import { AstService as AstServiceCtor } from "../../../dist/ast/ast.service.js";
import { DocumentationService as DocumentationServiceCtor } from "../../../dist/ast/documentation.service.js";
import { SyncService as SyncServiceCtor } from "../../../dist/sync/sync.service.js";
import { LiveWatchService as LiveWatchServiceCtor } from "../../../dist/sync/live-watch.service.js";
import type { AstService, DocumentationService, GitService, LiveWatchService, SyncService } from "../types";

export interface RapidDocsBackend {
  appContext: { close: () => Promise<void> };
  gitService: GitService;
  astService: AstService;
  documentationService: DocumentationService;
  syncService: SyncService;
  // Kept for the single-shared-instance callers that already exist
  // (test-commands, which stay single-root-scoped for now) -- NOT used by
  // the real multi-root activation path below, which needs one independent
  // watcher per folder instead of one shared one.
  liveWatchService: LiveWatchService;
  // Multi-root support (2026-08-15): LiveWatchService.start(repoPath) can
  // only ever watch ONE repo at a time -- calling it again for a different
  // repoPath silently overwrites the internal handle, leaking the old
  // watcher (see live-watch.service.ts's own start() comment). Getting a
  // genuinely independent watcher per folder means NOT reusing the single
  // NestJS-resolved singleton instance -- LiveWatchService's constructor
  // only depends on GitService/SyncService, both already confirmed
  // stateless (every method takes repoPath as an argument), so a fresh
  // instance can safely be constructed directly, reusing those same shared
  // services, without needing a second NestJS application context and
  // without touching LiveWatchService's own @Injectable() scope in the
  // shared src/ backend at all.
  createLiveWatchService: () => LiveWatchService;
}

export async function bootstrapBackend(): Promise<RapidDocsBackend> {
  const appContext = await NestFactory.createApplicationContext(AppModule, { logger: false });
  // Deliberately left as their INFERRED type here (whatever TypeScript's own
  // allowJs analysis of the compiled .js derives), not annotated with the
  // structural types from ../types -- createLiveWatchService below needs to
  // hand the REAL gitService/syncService instances to LiveWatchServiceCtor's
  // own constructor, which expects that real (inferred) shape, not the
  // narrower structural view of it.
  const gitService = appContext.get(GitServiceCtor);
  const astService = appContext.get(AstServiceCtor);
  const documentationService = appContext.get(DocumentationServiceCtor);
  const syncService = appContext.get(SyncServiceCtor);
  const liveWatchService = appContext.get(LiveWatchServiceCtor);

  return {
    appContext,
    // Cast to the structural types explicitly here, at the return boundary
    // only -- allowJs's inference from plain compiled JS (no source .ts,
    // no .d.ts) is real but imprecise (e.g. widens a literal union like
    // "info" | "warning" | "error" to plain string), close enough to be
    // useful but not exact enough to satisfy a strict structural assignment
    // check. The REST of the extension only ever consumes these through the
    // ../types interfaces anyway, so this is the one place that needs to
    // bridge "real but imprecise" into "our own precise contract".
    gitService: gitService as unknown as GitService,
    astService: astService as unknown as AstService,
    documentationService: documentationService as unknown as DocumentationService,
    syncService: syncService as unknown as SyncService,
    liveWatchService: liveWatchService as unknown as LiveWatchService,
    createLiveWatchService: () => new LiveWatchServiceCtor(gitService, syncService),
  };
}
