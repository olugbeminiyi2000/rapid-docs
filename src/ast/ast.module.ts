import { Module } from "@nestjs/common";
import { AstController } from "./ast.controller.js";
import { AstService } from "./ast.service.js";
import { DocumentationService } from "./documentation.service.js";

@Module({
  imports: [],
  controllers: [AstController],
  providers: [AstService, DocumentationService],
  exports: [AstService, DocumentationService],
})
export class AstModule {}
