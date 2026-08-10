import * as vscode from "vscode";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AstService, RawFoundNodeLike } from "../types";

// Section 2 (AstService) of the parity checklist -- ping() was already
// exercised with real evidence during Section 1's DI-graph proof, and
// parseSource/walkAllNodes/hashNode are all exercised transitively by
// reconcile()/decorations/Documented Sections, but none of the five methods
// had been asserted against KNOWN, real, self-verified output directly.
// Chained together here against one real sample, in the order they actually
// depend on each other: parse -> walk -> filter -> name -> hash.
export function registerTestAstService(context: vscode.ExtensionContext, astService: AstService): void {
  const disposable = vscode.commands.registerCommand("rapidDocs.testAstService", () => {
    const sample = `@Injectable()
class GreetingService {
  greet(name: string): string {
    return "Hello, " + name;
  }
}
`;
    const lines: string[] = [];

    // parseSource -- re-confirms the decorators-legacy fix through THIS
    // exact integration path, not just the isolated Jest suite.
    const parseResult = astService.parseSource(sample, "greeting.service.ts");
    lines.push(`parseSource: fatal=${parseResult.fatal}, ast=${parseResult.ast !== null ? "present" : "null"}, errors=${parseResult.errors.length}`);
    if (!parseResult.ast) {
      writeFileSync(join(tmpdir(), "rapid-docs-astservice-proof.txt"), lines.join("\n"));
      vscode.window.showErrorMessage("rapid-docs: AstService test failed at parseSource, see proof file.");
      return;
    }

    // walkAllNodes -- real node count off a real parse.
    const allNodes = astService.walkAllNodes((parseResult.ast as { program: { body: unknown } }).program.body);
    lines.push(`walkAllNodes: found ${allNodes.size} real nodes`);

    // extractName -- find the real "greet" ClassMethod among the walked nodes and confirm its name resolves correctly.
    let greetNode: RawFoundNodeLike | null = null;
    for (const entry of allNodes.values()) {
      if (entry.type === "ClassMethod") {
        greetNode = entry;
        break;
      }
    }
    const extractedName = greetNode ? astService.extractName(greetNode.node) : null;
    lines.push(`extractName on the real ClassMethod node: "${extractedName}" (expected "greet")`);

    // filterByHighlight -- narrow to just the ClassMethod's own span, confirm containment is respected.
    const filtered = greetNode ? astService.filterByHighlight(allNodes, greetNode.start, greetNode.end) : [];
    const allContained = greetNode ? filtered.every((n) => n.start >= greetNode!.start && n.end <= greetNode!.end) : false;
    lines.push(`filterByHighlight: ${filtered.length} node(s) inside the method's own range, all correctly contained=${allContained}`);

    // hashNode -- determinism (same node twice -> same hash) and distinctness (different node -> different hash).
    const hash1 = greetNode ? astService.hashNode(greetNode.node) : null;
    const hash2 = greetNode ? astService.hashNode(greetNode.node) : null;
    const otherNode = [...allNodes.values()].find((n) => n !== greetNode);
    const otherHash = otherNode ? astService.hashNode(otherNode.node) : null;
    lines.push(`hashNode determinism: hash1 === hash2 = ${hash1 === hash2}`);
    lines.push(`hashNode distinctness: hash(greet) !== hash(other) = ${hash1 !== otherHash}`);
    lines.push(`sample hash: ${hash1}`);

    const summary = `AstService: ${allNodes.size} nodes, name="${extractedName}", filter=${filtered.length}, hash deterministic=${hash1 === hash2}`;
    vscode.window.showInformationMessage(`rapid-docs: ${summary}`);
    writeFileSync(join(tmpdir(), "rapid-docs-astservice-proof.txt"), `${new Date().toISOString()}\n${lines.join("\n")}\n`);
  });
  context.subscriptions.push(disposable);
}
