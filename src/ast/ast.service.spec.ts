import { AstService } from "./ast.service.js";

describe("AstService", () => {
  let service: AstService;

  beforeEach(() => {
    service = new AstService();
  });

  describe("parseSource", () => {
    it("parses valid code successfully", () => {
      const result = service.parseSource("const x = 5;", "test.ts");
      expect(result.fatal).toBe(false);
      expect(result.ast).not.toBeNull();
      expect(result.errors).toEqual([]);
    });

    it("returns fatal:true for genuinely unparseable input, without throwing", () => {
      const result = service.parseSource("const = ;;;)))", "test.ts");
      expect(result.fatal).toBe(true);
      expect(result.ast).toBeNull();
      expect(result.errors.length).toBeGreaterThan(0);
    });

    // Real bug found via manual testing against a real React/Vite repo:
    // every single .jsx file in it failed to parse, unconditionally --
    // the jsx Babel plugin was never enabled at all.
    const jsxCode = `export function Greeting({ name }) {\n  return <div className="greeting">Hello, {name}!</div>;\n}\n`;

    it("parses real JSX syntax successfully for a .jsx file", () => {
      const result = service.parseSource(jsxCode, "components/Greeting.jsx");
      expect(result.fatal).toBe(false);
      expect(result.ast).not.toBeNull();
    });

    it("parses real JSX syntax successfully for a .tsx file", () => {
      const result = service.parseSource(jsxCode, "components/Greeting.tsx");
      expect(result.fatal).toBe(false);
      expect(result.ast).not.toBeNull();
    });

    it("still fails to parse JSX syntax in a plain .ts file -- the jsx plugin is extension-gated, not global", () => {
      const result = service.parseSource(jsxCode, "components/Greeting.ts");
      expect(result.fatal).toBe(true);
      expect(result.ast).toBeNull();
    });

    it("still fails to parse JSX syntax in a plain .js file", () => {
      const result = service.parseSource(jsxCode, "components/Greeting.js");
      expect(result.fatal).toBe(true);
      expect(result.ast).toBeNull();
    });
  });

  const sampleCode = `function greet(name) {
  const message = "Hello, " + name;
  console.log(message);
}

const x = 10;
`;

  describe("walkAllNodes", () => {
    it("finds every node in the file, deduped", () => {
      const { ast } = service.parseSource(sampleCode, "test.ts");
      const found = service.walkAllNodes(ast!.program.body);
      expect(found.size).toBe(20);
    });

    it("does not double-count shorthand destructuring key/value", () => {
      const richCode = `class Greeter {
  async sayHi(name) {
    const { first, ...rest } = name;
    const list = [1, 2, 3];
    const doubled = list.map((n) => n * 2);
    const label = \`Hi \${first}\`;
    return label ?? "default";
  }
}
`;
      const { ast } = service.parseSource(richCode, "test.ts");
      const found = service.walkAllNodes(ast!.program.body);
      expect(found.size).toBe(45);
    });
  });

  describe("filterByHighlight", () => {
    it("only returns nodes fully contained within the given range", () => {
      const { ast } = service.parseSource(sampleCode, "test.ts");
      const allNodes = service.walkAllNodes(ast!.program.body);
      const matched = service.filterByHighlight(allNodes, 0, 84);
      expect(matched.length).toBe(16);
      expect(matched.every((n) => n.start >= 0 && n.end <= 84)).toBe(true);
    });
  });

  describe("extractName", () => {
    function nodeOfType(code: string, type: string) {
      const { ast } = service.parseSource(code, "test.ts");
      const allNodes = service.walkAllNodes(ast!.program.body);
      const entry = [...allNodes.values()].find((n) => n.type === type);
      if (!entry) throw new Error(`No ${type} node found in parsed code`);
      return entry.node;
    }

    it("names a function declaration", () => {
      expect(service.extractName(nodeOfType("function greet(name) {}", "FunctionDeclaration"))).toBe("greet");
    });

    it("names a class declaration", () => {
      expect(service.extractName(nodeOfType("class Greeter {}", "ClassDeclaration"))).toBe("Greeter");
    });

    it("names a variable declaration, joining multiple declared names", () => {
      expect(service.extractName(nodeOfType("const x = 1;", "VariableDeclaration"))).toBe("x");
      expect(service.extractName(nodeOfType("const a = 1, b = 2;", "VariableDeclaration"))).toBe("a, b");
    });

    it("follows an export wrapper to the name of what it actually exports", () => {
      expect(service.extractName(nodeOfType("export function greet(name) {}", "ExportNamedDeclaration"))).toBe(
        "greet"
      );
      expect(service.extractName(nodeOfType("export default function greet() {}", "ExportDefaultDeclaration"))).toBe(
        "greet"
      );
    });

    it("names a class method by its key", () => {
      expect(service.extractName(nodeOfType("class Greeter { sayHi() {} }", "ClassMethod"))).toBe("sayHi");
    });

    it("returns null for a node with no name concept at all -- an anonymous function", () => {
      expect(service.extractName(nodeOfType("setTimeout(function () {}, 1000);", "FunctionExpression"))).toBeNull();
    });

    it("returns null for a comment node, real evidence that comments end up in walkAllNodes at all", () => {
      // Comments aren't part of ast.program.body directly -- Babel attaches
      // them as leadingComments/trailingComments on the nodes they're near,
      // and walkAllNodes recurses into those like any other nested object,
      // which is how they end up as their own separate entries at all.
      const commentNode = nodeOfType("// a real comment\nconst x = 1;", "CommentLine");
      expect(service.extractName(commentNode)).toBeNull();
    });

    it("returns null for null/non-object input, without throwing", () => {
      expect(service.extractName(null)).toBeNull();
      expect(service.extractName(undefined)).toBeNull();
      expect(service.extractName("not a node")).toBeNull();
    });
  });

  describe("hashNode", () => {
    const whitespaceChanged = `

function greet(name) {


  const message = "Hello, " + name;
  console.log(message);
}

const x = 10;
`;

    const renamed = `function greet(name) {
  const msg = "Hello, " + name;
  console.log(msg);
}

const x = 10;
`;

    function hashSet(code: string): Set<string> {
      const { ast } = service.parseSource(code, "test.ts");
      const allNodes = service.walkAllNodes(ast!.program.body);
      return new Set([...allNodes.values()].map((n) => service.hashNode(n.node)));
    }

    it("is invariant to whitespace-only changes", () => {
      const originalHashes = hashSet(sampleCode);
      const whitespaceHashes = hashSet(whitespaceChanged);
      expect([...whitespaceHashes].sort()).toEqual([...originalHashes].sort());
    });

    it("is invariant to a comment's line-ending style (LF vs CRLF)", () => {
      // Real bug found via manual testing: a multi-line comment captures its
      // own text VERBATIM, embedded newlines included. Git on Windows can
      // rewrite a file's line endings purely cosmetically on checkout/branch
      // switch, with zero actual code changes -- which, before this fix,
      // changed the hash of whatever node carried that comment and produced
      // a spurious drift warning for code that was never touched.
      const withLF = `/**\n * Builds something.\n * Second line.\n */\nfunction build() {\n  return 1;\n}\n`;
      const withCRLF = withLF.replace(/\n/g, "\r\n");

      expect([...hashSet(withCRLF)].sort()).toEqual([...hashSet(withLF)].sort());
    });

    it("changes only the renamed node and its ancestors, nothing else", () => {
      const originalHashes = hashSet(sampleCode);
      const renamedHashes = hashSet(renamed);

      const changed = [...originalHashes].filter((h) => !renamedHashes.has(h));
      expect(changed.length).toBe(7);
    });
  });
});
