import { Module } from "@nestjs/common";
import { AstModule } from "./ast/ast.module.js";
import { GitModule } from "./git/git.module.js";
import { SyncModule } from "./sync/sync.module.js";
import { WorkspaceModule } from "./workspace/workspace.module.js";

@Module({
  imports: [AstModule, GitModule, SyncModule, WorkspaceModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
