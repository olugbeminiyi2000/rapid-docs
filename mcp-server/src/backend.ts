import { NestFactory } from "@nestjs/core";
// Compiled dist/*.js, not raw src/*.ts -- same reasoning as
// vscode-extension/src/backend/bootstrap.ts's own header: esbuild/tsc
// transform decorator metadata differently, and importing the ALREADY
// tsc-compiled output (via `npm run build-backend`, nest's own `tsc`) is
// what makes NestJS's constructor-based DI actually resolve. This process
// is plain Node running compiled JS, so there's no bundler step at all --
// just a direct import of the real build output, same backend every other
// head (vscode-extension, the deprecated electron app) already reuses.
import { AppModule } from "../../dist/app.module.js";
import { DocumentationService as DocumentationServiceCtor } from "../../dist/ast/documentation.service.js";
import type { DocumentationService } from "./types.js";

export interface RapidDocsBackend {
  close: () => Promise<void>;
  documentationService: DocumentationService;
}

// Deliberately NOT reusing vscode-extension's own bootstrapBackend(): this
// process never needs GitService/SyncService/LiveWatchService at all -- the
// ten tools this server exposes (see tools.ts) are all point-in-time
// read/write calls against a given repoPath, not a persistent live-watch
// subscription, which is the one thing those other services exist for (see
// live-watch.service.ts's own header). Pulling in only what's actually used
// keeps this process's own startup simple and keeps it from carrying
// machinery (a chokidar watcher, a git-repo precondition) that nothing here
// would ever call.
export async function bootstrapBackend(): Promise<RapidDocsBackend> {
  const appContext = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const documentationService = appContext.get(DocumentationServiceCtor);

  return {
    close: () => appContext.close(),
    // Cast at the return boundary only -- same reasoning as
    // vscode-extension's bootstrap.ts: allowJs's inference from plain
    // compiled JS (no .d.ts) is real but imprecise, close enough to be
    // useful but not exact enough for a strict structural assignment check.
    documentationService: documentationService as unknown as DocumentationService,
  };
}
