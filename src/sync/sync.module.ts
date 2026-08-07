import { Module } from "@nestjs/common";
import { AstModule } from "../ast/ast.module.js";
import { GitModule } from "../git/git.module.js";
import { LiveWatchService } from "./live-watch.service.js";
import { SyncService } from "./sync.service.js";

@Module({
  imports: [AstModule, GitModule],
  controllers: [],
  providers: [SyncService, LiveWatchService],
  exports: [SyncService, LiveWatchService],
})
export class SyncModule {}
