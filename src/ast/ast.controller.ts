import { Controller, Get } from "@nestjs/common";
import { AstService } from "./ast.service.js";

@Controller("ast")
export class AstController {
  constructor(private readonly astService: AstService) {}

  @Get("ping")
  ping() {
    return { message: this.astService.ping() };
  }
}
