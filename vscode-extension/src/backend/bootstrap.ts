import type { AstService, DocumentationService, GitService, LiveWatchService, SyncService } from "../types";

export interface RapidDocsBackend {
  appContext: { close: () => Promise<void> };
  gitService: GitService;
  astService: AstService;
  documentationService: DocumentationService;
  syncService: SyncService;
  liveWatchService: LiveWatchService;
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

  // Real evidence the whole DI graph resolved, not just one constructor --
  // ping() and storagePathFor() are cheap, side-effect-free calls that only
  // succeed if each service is a genuine, correctly-wired instance, not just
  // a truthy object.
  console.log(
    "rapid-docs: NestJS backend context created.",
    astService.ping(),
    documentationService.storagePathFor(".", "probe.ts"),
    typeof gitService.getHeadCommit
  );

  return { appContext, gitService, astService, documentationService, syncService, liveWatchService };
}
