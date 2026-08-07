import { Injectable } from "@nestjs/common";
import * as parser from "@babel/parser";
import type { File, SourceLocation } from "@babel/types";
import { createHash } from "crypto";

export interface ParseResult {
  ast: File | null;
  errors: unknown[];
  fatal: boolean;
}

export interface RawFoundNode {
  type: string;
  start: number;
  end: number;
  loc: SourceLocation | null;
  node: unknown;
}

const SKIP_PROPERTIES: Record<string, boolean> = { start: true, end: true, loc: true };

const EXCLUDED_HASH_PROPERTIES: Record<string, boolean> = {
  start: true,
  end: true,
  loc: true,
  extra: true,
  tokens: true,
  expectedNode: true,
};

@Injectable()
export class AstService {
  ping(): string {
    return "ast service is alive";
  }

  // relativePath decides whether the jsx plugin is enabled -- deliberately
  // NOT unconditional. A plain .ts file can use `<Foo>value` angle-bracket
  // type-assertion syntax, which becomes ambiguous with JSX the moment jsx
  // parsing is on (this is exactly why real TypeScript tooling requires
  // `.tsx` files to write `value as Foo` instead) -- enabling jsx
  // unconditionally would risk breaking a working .ts file to fix .jsx
  // ones. Every .jsx/.tsx file failing to parse at all, unconditionally,
  // was a real bug found via manual testing against a real React/Vite repo
  // (every single .jsx file reporting "failed to parse").
  parseSource(code: string, relativePath: string): ParseResult {
    const usesJsx = /\.(jsx|tsx)$/.test(relativePath);
    try {
      const ast = parser.parse(code, { errorRecovery: true, plugins: usesJsx ? ["typescript", "jsx"] : ["typescript"] });
      return { ast, errors: ast.errors ?? [], fatal: false };
    } catch (err: any) {
      return {
        ast: null,
        errors: [
          {
            message: err.message,
            code: err.code,
            reasonCode: err.reasonCode,
            loc: err.loc,
            pos: err.pos,
          },
        ],
        fatal: true,
      };
    }
  }

  walkAllNodes(
    DATA: unknown,
    resultMap: Map<string, RawFoundNode> = new Map()
  ): Map<string, RawFoundNode> {
    if (DATA === null) {
      return resultMap;
    }

    if (Array.isArray(DATA)) {
      DATA.forEach((element) => {
        this.walkAllNodes(element, resultMap);
      });
    } else if (typeof DATA === "object") {
      const nodeStart = (DATA as { start?: unknown }).start;
      const nodeEnd = (DATA as { end?: unknown }).end;

      const entries = Object.entries(DATA as Record<string, unknown>);

      entries.forEach(([key, value]) => {
        if (SKIP_PROPERTIES[key]) {
          return;
        }

        if (key.toLowerCase() === "type") {
          if (typeof nodeStart === "number" && typeof nodeEnd === "number") {
            const loc = (DATA as { loc?: SourceLocation }).loc ?? null;
            const mapKey = `${value}:${nodeStart}:${nodeEnd}`;
            resultMap.set(mapKey, {
              type: value as string,
              start: nodeStart,
              end: nodeEnd,
              loc,
              node: DATA,
            });
          }
        } else if (typeof value === "object" && value !== null) {
          this.walkAllNodes(value, resultMap);
        }
      });
    }

    return resultMap;
  }

  filterByHighlight(
    allNodes: Map<string, RawFoundNode>,
    highlightStart: number,
    highlightEnd: number
  ): RawFoundNode[] {
    const matches: RawFoundNode[] = [];

    for (const entry of allNodes.values()) {
      if (entry.start >= highlightStart && entry.end <= highlightEnd) {
        matches.push(entry);
      }
    }

    return matches;
  }

  // Pulls a human-readable name out of the underlying node's own identifier,
  // where one genuinely exists -- a function, class, or variable's own
  // name. Returns null for anything without a name concept at all (an
  // anonymous function, an expression, a comment) rather than guessing;
  // callers fall back to describing the node by type alone in that case.
  extractName(node: unknown): string | null {
    if (node === null || typeof node !== "object") {
      return null;
    }

    const anyNode = node as Record<string, any>;

    switch (anyNode.type) {
      case "FunctionDeclaration":
      case "ClassDeclaration":
      case "TSInterfaceDeclaration":
      case "TSTypeAliasDeclaration":
      case "TSEnumDeclaration":
        return anyNode.id?.name ?? null;

      case "VariableDeclarator":
        return anyNode.id?.type === "Identifier" ? anyNode.id.name : null;

      case "VariableDeclaration": {
        const names = (anyNode.declarations ?? [])
          .map((declarator: any) => (declarator.id?.type === "Identifier" ? declarator.id.name : null))
          .filter((name: string | null): name is string => name !== null);
        return names.length > 0 ? names.join(", ") : null;
      }

      // A named export/default export has no name of its own -- the name
      // belongs to whatever it wraps (a function, class, or variable).
      case "ExportNamedDeclaration":
      case "ExportDefaultDeclaration":
        return anyNode.declaration ? this.extractName(anyNode.declaration) : null;

      case "ClassMethod":
      case "ClassProperty":
      case "ObjectMethod":
      case "ObjectProperty":
      case "TSPropertySignature":
      case "TSMethodSignature":
        if (anyNode.key?.type === "Identifier") return anyNode.key.name;
        if (anyNode.key?.type === "StringLiteral") return anyNode.key.value;
        return null;

      default:
        return null;
    }
  }

  hashNode(DATA: unknown): string {
    return createHash("sha256").update(this.canonicalize(DATA)).digest("hex");
  }

  // A multi-line comment (or any other string a node happens to carry, e.g.
  // a template literal) captures its own text VERBATIM, embedded newlines
  // and all. Git on Windows can rewrite a file's line endings (LF <-> CRLF)
  // purely cosmetically on checkout/branch-switch, with the meaningful
  // content completely unchanged -- confirmed for real: switching branches
  // and back, with zero actual edits, flipped a comment's embedded `\n` to
  // `\r\n`, which changed the hash of whatever node carried that comment and
  // produced a spurious drift warning. Normalizing here, only at the point a
  // string is serialized for hashing, makes the hash itself insensitive to
  // that purely cosmetic difference -- deliberately NOT normalizing the
  // actual parsed source text anywhere else, since every node's real
  // start/end/loc must keep matching the file exactly as Monaco and the rest
  // of the app read and display it.
  private normalizeLineEndings(value: string): string {
    return value.replace(/\r\n/g, "\n");
  }

  private canonicalize(DATA: unknown): string {
    if (DATA === null) {
      return "null";
    }

    if (Array.isArray(DATA)) {
      return `[${DATA.map((element) => this.canonicalize(element)).join(",")}]`;
    }

    if (typeof DATA === "object") {
      const entries = Object.entries(DATA as Record<string, unknown>)
        .filter(([key]) => !EXCLUDED_HASH_PROPERTIES[key])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

      const parts = entries.map(([key, value]) => {
        if (typeof value === "object" && value !== null) {
          return `${key}:${this.canonicalize(value)}`;
        }
        const normalized = typeof value === "string" ? this.normalizeLineEndings(value) : value;
        return `${key}:${JSON.stringify(normalized)}`;
      });

      return `{${parts.join(",")}}`;
    }

    const normalized = typeof DATA === "string" ? this.normalizeLineEndings(DATA) : DATA;
    return JSON.stringify(normalized);
  }
}
