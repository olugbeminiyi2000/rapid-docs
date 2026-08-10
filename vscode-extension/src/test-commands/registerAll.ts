import * as vscode from "vscode";
import type { RapidDocsBackend } from "../backend/bootstrap";
import { registerInitialProbes } from "./initialProbes";
import { registerTestAstService } from "./testAstService";
import { registerTestGitService } from "./testGitService";
import { registerTestDocumentationService } from "./testDocumentationService";
import { registerTestSyncService } from "./testSyncService";
import { registerTestLiveWatchService } from "./testLiveWatchService";

export interface RegisterTestCommandsDeps {
  backend: RapidDocsBackend;
  diagnosticCollection: vscode.DiagnosticCollection;
  documentedDecorationType: vscode.TextEditorDecorationType;
  refreshDocumentedSectionsView: () => Promise<void>;
}

// Registers every Section 1-6 proof-file test command (rapidDocs.test*),
// kept separate from the real UI code being built in Section 7 so the two
// don't get jumbled together the way electron/renderer.js's ~1900 lines did.
export function registerAllTestCommands(context: vscode.ExtensionContext, deps: RegisterTestCommandsDeps): void {
  const { backend } = deps;

  registerInitialProbes(context, {
    gitService: backend.gitService,
    syncService: backend.syncService,
    documentationService: backend.documentationService,
    liveWatchService: backend.liveWatchService,
    diagnosticCollection: deps.diagnosticCollection,
    documentedDecorationType: deps.documentedDecorationType,
    refreshDocumentedSectionsView: deps.refreshDocumentedSectionsView,
  });
  registerTestAstService(context, backend.astService);
  registerTestGitService(context, backend.gitService);
  registerTestDocumentationService(context, backend.documentationService);
  registerTestSyncService(context, { gitService: backend.gitService, documentationService: backend.documentationService, syncService: backend.syncService });
  registerTestLiveWatchService(context, backend.liveWatchService);
}
