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

// Same dynamic-import pattern electron/main.ts's bootstrapEngine() uses, and
// for the same reason: dist/app.module.js is a real ES module (root
// package.json says "type": "module"), and this file compiles to CommonJS,
// so require() can't load it directly -- only a dynamic import() can bridge
// a CommonJS file to a genuine ESM one. The relative path depth is identical
// too: vscode-extension/dist/backend/bootstrap.js sits exactly as many
// levels under the repo root as electron/dist/main.js does.
export async function bootstrapBackend(): Promise<RapidDocsBackend> {
  const { NestFactory } = await import("@nestjs/core");
  // @ts-expect-error -- dist/ is a separately-compiled, untyped JS output, same boundary electron/main.ts already crosses
  const { AppModule } = await import("../../../dist/app.module.js");
  // @ts-expect-error -- see above
  const { GitService: GitServiceCtor } = await import("../../../dist/git/git.service.js");
  // @ts-expect-error -- see above
  const { AstService: AstServiceCtor } = await import("../../../dist/ast/ast.service.js");
  // @ts-expect-error -- see above
  const { DocumentationService: DocumentationServiceCtor } = await import("../../../dist/ast/documentation.service.js");
  // @ts-expect-error -- see above
  const { SyncService: SyncServiceCtor } = await import("../../../dist/sync/sync.service.js");
  // @ts-expect-error -- see above
  const { LiveWatchService: LiveWatchServiceCtor } = await import("../../../dist/sync/live-watch.service.js");

  const appContext = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const gitService: GitService = appContext.get(GitServiceCtor);
  const astService: AstService = appContext.get(AstServiceCtor);
  const documentationService: DocumentationService = appContext.get(DocumentationServiceCtor);
  const syncService: SyncService = appContext.get(SyncServiceCtor);
  const liveWatchService: LiveWatchService = appContext.get(LiveWatchServiceCtor);

  return {
    appContext,
    gitService,
    astService,
    documentationService,
    syncService,
    liveWatchService,
    createLiveWatchService: () => new LiveWatchServiceCtor(gitService, syncService),
  };
}
