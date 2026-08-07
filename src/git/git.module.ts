import { Module } from "@nestjs/common";
import { GitService } from "./git.service.js";

@Module({
  imports: [],
  controllers: [],
  providers: [GitService],
  exports: [GitService],
})
export class GitModule {}
