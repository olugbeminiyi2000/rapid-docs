import { writeFileSync, rmSync, existsSync, mkdirSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { AstService } from "./ast.service.js";
import { DocumentationService } from "./documentation.service.js";

describe("DocumentationService", () => {
  let astService: AstService;
  let docService: DocumentationService;
  let repoPath: string;

  const relativePath = "sample.js";
  const renamedRelativePath = "renamed-sample.js";

  const originalCode = `function greet(name) {
  const message = "Hello, " + name;
  console.log(message);
}

const x = 10;
`;

  const renamedCode = `function greet(name) {
  const msg = "Hello, " + name;
  console.log(msg);
}

const x = 10;
`;

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), "doc-service-test-"));
    writeFileSync(join(repoPath, relativePath), originalCode);
    astService = new AstService();
    docService = new DocumentationService(astService);
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  describe("storagePathFor", () => {
    it("mirrors the source tree structure under .rapid-docs/", () => {
      const path = docService.storagePathFor(repoPath, "src/utils/helpers.js");
      expect(path).toBe(join(repoPath, ".rapid-docs", "src", "utils", "helpers.js.json"));
    });
  });

  describe("canParseFile", () => {
    it("returns true for valid, parseable code", () => {
      expect(docService.canParseFile(repoPath, relativePath)).toBe(true);
    });

    it("returns false for genuinely unparseable code", () => {
      writeFileSync(join(repoPath, relativePath), "const = ;;;)))");
      expect(docService.canParseFile(repoPath, relativePath)).toBe(false);
    });

    it("returns true for a real .jsx file using actual JSX syntax", () => {
      const jsxPath = "Greeting.jsx";
      writeFileSync(
        join(repoPath, jsxPath),
        `export function Greeting({ name }) {\n  return <div>Hello, {name}!</div>;\n}\n`
      );
      expect(docService.canParseFile(repoPath, jsxPath)).toBe(true);
    });
  });

  describe("writeDoc", () => {
    it("documents a highlight with a content-derived recordId", () => {
      const { recordId, record } = docService.writeDoc(
        repoPath,
        relativePath,
        0,
        84,
        "greet() builds and logs a greeting."
      );
      expect(recordId).toHaveLength(64);
      expect(record.members.length).toBe(16);
    });

    it("refuses to document the exact same highlight twice", () => {
      docService.writeDoc(repoPath, relativePath, 0, 84, "first attempt");
      expect(() => docService.writeDoc(repoPath, relativePath, 0, 84, "second attempt")).toThrow(
        /already documented/
      );
    });
  });

  describe("findRecordForSelection", () => {
    // Real bug found via manual UI testing: a real drag-selection almost
    // never lands exactly on an AST node's precise starting character --
    // it commonly starts a little early, on the statement's leading
    // whitespace/indent. writeDoc happily accepts that (filterByHighlight's
    // contains-based semantics don't care), but a position-based "does this
    // match an existing record" check does, and wrongly says no.
    it("finds a record even when the selection's boundary is looser than the underlying node's exact position", () => {
      const memberStart = originalCode.indexOf("const message");
      const memberEnd = originalCode.indexOf(";", memberStart) + 1;

      const { recordId } = docService.writeDoc(
        repoPath,
        relativePath,
        memberStart,
        memberEnd,
        "Builds the greeting message."
      );

      const looseStart = memberStart - 2; // includes the statement's leading indent
      const found = docService.findRecordForSelection(repoPath, relativePath, looseStart, memberEnd);

      expect(found).not.toBeNull();
      expect(found?.recordId).toBe(recordId);
      expect(found?.docText).toBe("Builds the greeting message.");
    });

    it("returns null when the selection doesn't match any stored record", () => {
      expect(docService.findRecordForSelection(repoPath, relativePath, 0, 10)).toBeNull();
    });

    it("returns null for a file that fails to parse, rather than throwing", () => {
      writeFileSync(join(repoPath, relativePath), "const = ;;;)))");
      expect(() => docService.findRecordForSelection(repoPath, relativePath, 0, 5)).not.toThrow();
      expect(docService.findRecordForSelection(repoPath, relativePath, 0, 5)).toBeNull();
    });
  });

  describe("deleteRecord", () => {
    it("removes a record", () => {
      const { recordId } = docService.writeDoc(repoPath, relativePath, 0, 84, "doc text");
      docService.deleteRecord(repoPath, relativePath, recordId);
      const storage = docService.loadStorage(repoPath, relativePath);
      expect(storage.records[recordId]).toBeUndefined();
    });

    it("throws for a nonexistent record", () => {
      expect(() => docService.deleteRecord(repoPath, relativePath, "nonexistent")).toThrow(/No record/);
    });
  });

  describe("editDocText", () => {
    it("updates only the text, leaving members untouched", () => {
      const { recordId, record } = docService.writeDoc(repoPath, relativePath, 0, 84, "original text");
      const originalMembers = JSON.stringify(record.members);

      docService.editDocText(repoPath, relativePath, recordId, "updated text");

      const reloaded = docService.loadStorage(repoPath, relativePath);
      expect(reloaded.records[recordId].docText).toBe("updated text");
      expect(JSON.stringify(reloaded.records[recordId].members)).toBe(originalMembers);
    });
  });

  describe("findStaleRecordForSelection", () => {
    it("finds a partially-stale record whose surviving anchors overlap the given selection", () => {
      const { recordId } = docService.writeDoc(repoPath, relativePath, 0, 84, "greet() builds and logs a greeting.");
      writeFileSync(join(repoPath, relativePath), renamedCode);

      const found = docService.findStaleRecordForSelection(repoPath, relativePath, 0, renamedCode.indexOf("\nconst x"));

      expect(found).not.toBeNull();
      expect(found?.recordId).toBe(recordId);
      expect(found?.docText).toBe("greet() builds and logs a greeting.");
    });

    it("returns null when the selection doesn't overlap any stale record's surviving anchors", () => {
      docService.writeDoc(repoPath, relativePath, 0, 84, "greet() builds and logs a greeting.");
      writeFileSync(join(repoPath, relativePath), renamedCode);

      // The untouched `const x = 10;` tail, nowhere near where greet()'s
      // still-anchored content lives.
      const xStart = renamedCode.indexOf("const x");
      const found = docService.findStaleRecordForSelection(repoPath, relativePath, xStart, xStart + 13);

      expect(found).toBeNull();
    });

    it("returns null when nothing has actually drifted", () => {
      docService.writeDoc(repoPath, relativePath, 0, 84, "greet() builds and logs a greeting.");
      expect(docService.findStaleRecordForSelection(repoPath, relativePath, 0, 84)).toBeNull();
    });

    it("returns null for a fully-stale record -- nothing survives to anchor a position to", () => {
      const { recordId } = docService.writeDoc(repoPath, relativePath, 0, 84, "greet() builds and logs a greeting.");
      const unrelatedCode = `function totallyDifferent() {\n  return 42;\n}\n`;
      writeFileSync(join(repoPath, relativePath), unrelatedCode);

      const report = docService.checkFile(repoPath, relativePath);
      expect(report.driftResults.find((d) => d.recordId === recordId)?.status).toBe("fully_stale");

      expect(docService.findStaleRecordForSelection(repoPath, relativePath, 0, unrelatedCode.length)).toBeNull();
    });
  });

  describe("updateDriftedDoc", () => {
    it("retires the old record and writes a fresh one matching the current code", () => {
      const { recordId: oldRecordId } = docService.writeDoc(
        repoPath,
        relativePath,
        0,
        84,
        "greet() builds and logs a greeting."
      );
      writeFileSync(join(repoPath, relativePath), renamedCode);

      const { recordId: newRecordId } = docService.updateDriftedDoc(
        repoPath,
        relativePath,
        oldRecordId,
        0,
        84,
        "greet() builds and logs a greeting, using msg as the local variable name now."
      );

      expect(newRecordId).not.toBe(oldRecordId);

      const storage = docService.loadStorage(repoPath, relativePath);
      expect(storage.records[oldRecordId]).toBeUndefined();
      expect(storage.records[newRecordId].docText).toBe(
        "greet() builds and logs a greeting, using msg as the local variable name now."
      );

      // The whole point: checkFile against the SAME current code now reports
      // this record unchanged, not partially stale.
      const report = docService.checkFile(repoPath, relativePath);
      expect(report.driftResults.find((d) => d.recordId === newRecordId)?.status).toBe("unchanged");
    });

    it("throws for a nonexistent oldRecordId", () => {
      expect(() => docService.updateDriftedDoc(repoPath, relativePath, "nonexistent", 0, 84, "text")).toThrow(
        /No record/
      );
    });

    it("throws when the current selection already exactly matches a different existing record", () => {
      // The "name" parameter sits entirely before where original/renamed
      // code diverge (the message -> msg rename happens on the next line),
      // so its position AND hash are identical in both -- a real "this
      // exact node, still untouched" duplicate, not a coincidental one.
      const paramStart = originalCode.indexOf("(name)") + 1;
      const paramEnd = paramStart + 4;
      expect(originalCode.slice(paramStart, paramEnd)).toBe("name");
      expect(renamedCode.slice(paramStart, paramEnd)).toBe("name");

      docService.writeDoc(repoPath, relativePath, paramStart, paramEnd, "the name parameter");
      const { recordId: greetRecordId } = docService.writeDoc(
        repoPath,
        relativePath,
        0,
        84,
        "greet() builds and logs a greeting."
      );
      writeFileSync(join(repoPath, relativePath), renamedCode);

      // Selecting that exact same, still-untouched "name" parameter again
      // while trying to resolve drift on the unrelated greet() record should
      // refuse, the same way writeDoc refuses a duplicate.
      expect(() =>
        docService.updateDriftedDoc(repoPath, relativePath, greetRecordId, paramStart, paramEnd, "new text")
      ).toThrow(/already documented/);
    });

    it("throws for a file that fails to parse", () => {
      const { recordId } = docService.writeDoc(repoPath, relativePath, 0, 84, "greet() builds and logs a greeting.");
      writeFileSync(join(repoPath, relativePath), "const = ;;;)))");
      expect(() => docService.updateDriftedDoc(repoPath, relativePath, recordId, 0, 5, "text")).toThrow(
        /failed to parse/
      );
    });
  });

  describe("renameFile", () => {
    it("moves storage to the new fileId", () => {
      docService.writeDoc(repoPath, relativePath, 0, 84, "doc text");
      docService.renameFile(repoPath, relativePath, renamedRelativePath);

      expect(existsSync(docService.storagePathFor(repoPath, relativePath))).toBe(false);
      expect(existsSync(docService.storagePathFor(repoPath, renamedRelativePath))).toBe(true);
    });

    it("refuses to rename onto an existing target", () => {
      docService.writeDoc(repoPath, relativePath, 0, 84, "doc text");
      writeFileSync(join(repoPath, renamedRelativePath), originalCode);
      docService.writeDoc(repoPath, renamedRelativePath, 0, 84, "unrelated doc");

      expect(() => docService.renameFile(repoPath, relativePath, renamedRelativePath)).toThrow(
        /Refusing to rename/
      );
    });

    it("creates whatever nested directories are needed when renaming into a deeper path", () => {
      docService.writeDoc(repoPath, relativePath, 0, 84, "doc text");
      const deepRelativePath = "src/nested/deep/renamed.js";

      docService.renameFile(repoPath, relativePath, deepRelativePath);

      expect(existsSync(docService.storagePathFor(repoPath, deepRelativePath))).toBe(true);
      expect(docService.loadStorage(repoPath, deepRelativePath).fileId).toBe(deepRelativePath);
    });
  });

  describe("handleDeletedFile", () => {
    it("surfaces the old docText in a message, then removes the storage", () => {
      docService.writeDoc(repoPath, relativePath, 0, 84, "greet() builds and logs a greeting.");

      const messages = docService.handleDeletedFile(repoPath, relativePath);

      expect(messages).toHaveLength(1);
      expect(messages[0].severity).toBe("warning");
      expect(messages[0].text).toContain("greet() builds and logs a greeting.");
      expect(existsSync(docService.storagePathFor(repoPath, relativePath))).toBe(false);
    });

    it("returns one message per record when a file has multiple documented highlights", () => {
      docService.writeDoc(repoPath, relativePath, 0, 84, "first doc");
      docService.writeDoc(repoPath, relativePath, 0, originalCode.length, "second doc");

      const messages = docService.handleDeletedFile(repoPath, relativePath);

      expect(messages).toHaveLength(2);
      const texts = messages.map((m) => m.text).join(" | ");
      expect(texts).toContain("first doc");
      expect(texts).toContain("second doc");
    });

    it("returns an empty array when there was never any documentation for the file", () => {
      const messages = docService.handleDeletedFile(repoPath, relativePath);
      expect(messages).toEqual([]);
    });
  });

  describe("archive (handleDeletedFile, attachArchivedRecord, discardArchivedRecord)", () => {
    // Now that storage lives inside a fresh per-test repoPath, the archive is
    // naturally isolated per test too -- no shared-file concern across spec
    // files anymore, since each test gets its own .rapid-docs/_archive.json.
    function uniqueText(label: string): string {
      return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    it("archives the record's docText when a file is deleted", () => {
      const marker = uniqueText("archived");
      docService.writeDoc(repoPath, relativePath, 0, 84, marker);

      docService.handleDeletedFile(repoPath, relativePath);

      const archived = docService.loadArchive(repoPath).find((entry) => entry.docText === marker);
      expect(archived).toBeDefined();
      expect(archived?.originalFileId).toBe(relativePath);
    });

    it("archives every record when a file with multiple highlights is deleted", () => {
      const markerA = uniqueText("first");
      const markerB = uniqueText("second");
      docService.writeDoc(repoPath, relativePath, 0, 84, markerA);
      docService.writeDoc(repoPath, relativePath, 0, originalCode.length, markerB);

      docService.handleDeletedFile(repoPath, relativePath);

      const archive = docService.loadArchive(repoPath);
      expect(archive.some((e) => e.docText === markerA)).toBe(true);
      expect(archive.some((e) => e.docText === markerB)).toBe(true);
    });

    it("attachArchivedRecord creates a fresh record using the archived text, then removes the archive entry", () => {
      const marker = uniqueText("recovered");
      docService.writeDoc(repoPath, relativePath, 0, 84, marker);
      docService.handleDeletedFile(repoPath, relativePath);

      const archived = docService.loadArchive(repoPath).find((e) => e.docText === marker)!;

      // Attach to a DIFFERENT file, exactly like recovering documentation onto
      // whatever replaced the deleted one.
      writeFileSync(join(repoPath, renamedRelativePath), originalCode);
      const { recordId, record } = docService.attachArchivedRecord(
        repoPath,
        archived.id,
        renamedRelativePath,
        0,
        84
      );

      expect(record.docText).toBe(marker);
      expect(record.members.length).toBe(16);

      const storage = docService.loadStorage(repoPath, renamedRelativePath);
      expect(storage.records[recordId].docText).toBe(marker);

      expect(docService.loadArchive(repoPath).some((e) => e.id === archived.id)).toBe(false);
    });

    it("attachArchivedRecord throws for an unknown archive id", () => {
      expect(() => docService.attachArchivedRecord(repoPath, "nonexistent-id", relativePath, 0, 84)).toThrow(
        /No archived record/
      );
    });

    it("discardArchivedRecord removes an entry without creating any new record", () => {
      const marker = uniqueText("discard-me");
      docService.writeDoc(repoPath, relativePath, 0, 84, marker);
      docService.handleDeletedFile(repoPath, relativePath);

      const archived = docService.loadArchive(repoPath).find((e) => e.docText === marker)!;
      docService.discardArchivedRecord(repoPath, archived.id);

      expect(docService.loadArchive(repoPath).some((e) => e.id === archived.id)).toBe(false);
    });

    it("discardArchivedRecord throws for an unknown archive id", () => {
      expect(() => docService.discardArchivedRecord(repoPath, "nonexistent-id")).toThrow(/No archived record/);
    });

    it("loadArchive does not confuse _archive.json with a per-file storage entry", () => {
      const marker = uniqueText("guard");
      docService.writeDoc(repoPath, relativePath, 0, 84, marker);
      docService.handleDeletedFile(repoPath, relativePath);

      expect(docService.listDocumentedFileIds(repoPath)).not.toContain(undefined);
    });
  });

  describe("listDocumentedFileIds", () => {
    it("includes a fileId that currently has stored records", () => {
      docService.writeDoc(repoPath, relativePath, 0, 84, "doc text");

      expect(docService.listDocumentedFileIds(repoPath)).toContain(relativePath);
    });

    it("no longer includes a fileId once its storage has been removed", () => {
      docService.writeDoc(repoPath, relativePath, 0, 84, "doc text");
      docService.handleDeletedFile(repoPath, relativePath);

      expect(docService.listDocumentedFileIds(repoPath)).not.toContain(relativePath);
    });

    it("finds documented files nested in subdirectories, proving the recursive walk works", () => {
      const nestedRelativePath = "src/deep/nested.js";
      const fullPath = join(repoPath, nestedRelativePath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, originalCode);

      docService.writeDoc(repoPath, nestedRelativePath, 0, 84, "nested doc");

      expect(docService.listDocumentedFileIds(repoPath)).toContain(nestedRelativePath);
    });
  });

  describe("findDocumentedNodes", () => {
    it("returns one entry per documented record, not one per individual matched AST node", () => {
      const { recordId } = docService.writeDoc(repoPath, relativePath, 0, 84, "doc text");
      const found = docService.findDocumentedNodes(repoPath, relativePath);

      // The highlighted function matches 16 individual AST nodes (proven back
      // in Phase 1/2) -- but findDocumentedNodes should report ONE verified
      // span for the whole record, not 16 fragments.
      expect(found.length).toBe(1);
      expect(found[0].recordId).toBe(recordId);
    });

    // Real bug found via manual UI testing, not anticipated in advance: two
    // functions sharing generic parameter names (a, b) produce byte-identical
    // hashes for those identifiers, since hashing is deliberately structural
    // and position-invariant. The old implementation matched on any single
    // shared hash, wrongly attributing the second function's identifiers to
    // the first function's record. Verifying the COMPLETE combined hash at a
    // candidate boundary (the fix) rules this out entirely.
    it("does not attribute an unrelated function's identically-named parameters to a different function's record", () => {
      const sharedParamNamesCode = "function add(a, b) {\n  return a + b;\n}\n\nfunction sub(a, b) {\n  return a - b;\n}\n";
      writeFileSync(join(repoPath, relativePath), sharedParamNamesCode);

      const addFunctionEnd = sharedParamNamesCode.indexOf("\n\n");
      const { recordId } = docService.writeDoc(repoPath, relativePath, 0, addFunctionEnd, "adds two numbers");

      const found = docService.findDocumentedNodes(repoPath, relativePath);

      expect(found.length).toBe(1);
      expect(found[0].recordId).toBe(recordId);
      // The reconstructed span must stay within the `add` function -- it
      // must not stretch to include `sub`, which starts well after this.
      expect(found[0].end).toBeLessThanOrEqual(addFunctionEnd);
    });

    // Real bug found via manual UI testing: documenting the ENTIRE file (a
    // selection spanning multiple sibling top-level statements -- an import,
    // a function, a variable, with no single AST node whose own boundary
    // covers all of them) was stored correctly by writeDoc, but
    // findDocumentedNodes -- which only ever tried each INDIVIDUAL node's
    // own natural boundary as a candidate span -- could never find it again,
    // since no single node spans "multiple unrelated siblings." The
    // sidebar showed "Nothing documented," and the green highlight never
    // appeared, even though the record genuinely existed and the right-click
    // menu (a different code path, checking the actual selection directly)
    // correctly offered Edit/Delete.
    it("finds a record covering the WHOLE file -- multiple sibling statements with no single containing node", () => {
      const multiStatementCode = `function greet(name) {\n  console.log(name);\n}\n\nconst x = 10;\nconst y = 20;\n`;
      writeFileSync(join(repoPath, relativePath), multiStatementCode);

      const { recordId } = docService.writeDoc(repoPath, relativePath, 0, multiStatementCode.length, "documented the whole file");
      const found = docService.findDocumentedNodes(repoPath, relativePath);

      expect(found.length).toBe(1);
      expect(found[0].recordId).toBe(recordId);
    });

    // The same gap, one level down: several consecutive statements INSIDE a
    // function, not the whole file -- proof the fix isn't special-cased for
    // the top level only.
    it("finds a record covering several consecutive statements inside a function body", () => {
      const code = `function f() {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  return a + b + c;\n}\n`;
      writeFileSync(join(repoPath, relativePath), code);

      const bStart = code.indexOf("const b");
      const cEnd = code.indexOf("const c = 3;") + "const c = 3;".length;
      const { recordId } = docService.writeDoc(repoPath, relativePath, bStart, cEnd, "b and c together");

      const found = docService.findDocumentedNodes(repoPath, relativePath);
      expect(found.length).toBe(1);
      expect(found[0].recordId).toBe(recordId);
    });

    // Real bug found via manual testing: documenting a JSDoc comment
    // TOGETHER WITH the function it annotates showed up correctly via the
    // right-click menu (findRecordForSelection, driven by the actual
    // selection bounds) but never appeared in the Documented-sections
    // sidebar at all. Root cause: a comment is attached to the node it
    // precedes via a PROPERTY (leadingComments), not as a sibling array
    // element of it -- so no sibling-range candidate could ever span both,
    // no matter how the candidate-enumeration approach was extended. The
    // record-driven rewrite doesn't enumerate candidate shapes at all, so
    // this needs no special case: it just works, from the record's own
    // member hashes.
    it("finds a record covering a comment together with the function it annotates -- not siblings in any array", () => {
      const code = `/**\n * Decodes a run-length encoded string.\n */\nexport function runLengthDecode(encoded: string): string {\n  return encoded;\n}\n`;
      writeFileSync(join(repoPath, relativePath), code);

      const functionEnd = code.length - 1;
      const { recordId } = docService.writeDoc(repoPath, relativePath, 0, functionEnd, "explains decode");

      const found = docService.findDocumentedNodes(repoPath, relativePath);
      expect(found.length).toBe(1);
      expect(found[0].recordId).toBe(recordId);
    });
  });

  describe("checkFile and generateMessages", () => {
    it("reports unchanged status, and collapses the undocumented `x` group to one message", () => {
      docService.writeDoc(repoPath, relativePath, 0, 84, "greet() builds and logs a greeting.");
      const report = docService.checkFile(repoPath, relativePath);

      expect(report.driftResults).toHaveLength(1);
      expect(report.driftResults[0].status).toBe("unchanged");
      expect(report.undocumentedNodes.length).toBe(4);

      const messages = docService.generateMessages(repoPath, relativePath, report);
      const infoMessages = messages.filter((m) => m.severity === "info");
      expect(infoMessages.length).toBe(1);
      expect(infoMessages[0].text).toContain("VariableDeclaration");
      // Every message must say which file it's about, so a live-updating UI
      // can replace that file's prior messages instead of only ever appending.
      expect(messages.every((m) => m.relativePath === relativePath)).toBe(true);
    });

    it("reports partial staleness and matching counts after an edit", () => {
      docService.writeDoc(repoPath, relativePath, 0, 84, "greet() builds and logs a greeting.");
      writeFileSync(join(repoPath, relativePath), renamedCode);

      const report = docService.checkFile(repoPath, relativePath);
      const drift = report.driftResults[0];

      expect(drift.status).toBe("partially_stale");
      expect(drift.changedMembers.length).toBe(8);
      expect(drift.totalMembers).toBe(16);

      // Containers that only changed because of the rename (FunctionDeclaration,
      // BlockStatement, etc.) still contain the untouched "name" parameter and
      // other unchanged content, so they're correctly excluded here -- the
      // warning above already covers them, and reporting them again as
      // "undocumented" would be redundant. What's left: the two genuinely
      // renamed leaf identifiers, plus the separate, always-undocumented
      // `const x` (and its own three descendant nodes).
      expect(report.undocumentedNodes.length).toBe(6);

      const messages = docService.generateMessages(repoPath, relativePath, report);
      const warning = messages.find((m) => m.severity === "warning");
      expect(warning?.text).toContain("8 of 16 parts changed");

      const infoMessages = messages.filter((m) => m.severity === "info");
      expect(infoMessages.length).toBe(3);
    });

    // Real bug found via manual testing: two documented functions with
    // identical params/body (only the name differs, e.g. copy-pasted-then-
    // renamed) confused the drift-anchor computation for whichever one gets
    // renamed. matchingRanges is found by filtering ALL current nodes by
    // hash membership (documentation.service.ts's own anchor computation),
    // with no way to tell "this record's own surviving node" apart from an
    // unrelated node elsewhere that merely happens to hash identically --
    // real when the sibling function's params/body are structurally
    // untouched and therefore hash-identical to the renamed one's own
    // surviving members. beta's own anchors must never leak into alpha's span.
    it("does not misattribute a drifted record's matchingRanges to a different, structurally-identical function elsewhere in the file", () => {
      const twinCode = `function alpha(a, b) {\n  return a + b;\n}\n\nfunction beta(a, b) {\n  return a + b;\n}\n`;
      writeFileSync(join(repoPath, relativePath), twinCode);

      const alphaStart = 0;
      const alphaEnd = twinCode.indexOf("\n\nfunction beta") + 1;
      const betaStart = twinCode.indexOf("function beta");
      const betaEnd = twinCode.length;

      docService.writeDoc(repoPath, relativePath, alphaStart, alphaEnd, "documents alpha");
      const { recordId: betaRecordId } = docService.writeDoc(repoPath, relativePath, betaStart, betaEnd, "documents beta");

      const renamedTwinCode = twinCode.replace("function beta(", "function betaRenamed(");
      writeFileSync(join(repoPath, relativePath), renamedTwinCode);

      const newBetaStart = renamedTwinCode.indexOf("function betaRenamed");
      const newBetaEnd = renamedTwinCode.length;

      const report = docService.checkFile(repoPath, relativePath);
      const betaDrift = report.driftResults.find((d) => d.recordId === betaRecordId);

      expect(betaDrift?.status).toBe("partially_stale");
      expect(betaDrift!.matchingRanges.length).toBeGreaterThan(0);
      for (const range of betaDrift!.matchingRanges) {
        expect(range.start).toBeGreaterThanOrEqual(newBetaStart);
        expect(range.end).toBeLessThanOrEqual(newBetaEnd);
      }
    });

    // A real, HARDER variant found via manual testing right after the fix
    // above: renaming BOTH twins at once (not just one) leaves NEITHER
    // record with any still-unique name to anchor from -- their surviving
    // params/body are still hash-identical to EACH OTHER, so there is
    // genuinely no information left, for either record, that could say
    // which physical occurrence is really its own. There is no correct
    // answer to guess here (unlike the single-rename case, where the
    // OTHER, untouched twin's still-unique name gave a real seed to grow
    // from) -- the honest behavior is the same one findDocumentedNodes
    // already uses elsewhere: report the drift, but leave matchingRanges
    // empty rather than confidently point at the wrong function.
    it("reports no matchingRanges (rather than a wrong guess) when BOTH twins are renamed and neither has a unique anchor left", () => {
      const twinCode = `function alpha(a, b) {\n  return a + b;\n}\n\nfunction beta(a, b) {\n  return a + b;\n}\n`;
      writeFileSync(join(repoPath, relativePath), twinCode);

      const alphaStart = 0;
      const alphaEnd = twinCode.indexOf("\n\nfunction beta") + 1;
      const betaStart = twinCode.indexOf("function beta");
      const betaEnd = twinCode.length;

      const { recordId: alphaRecordId } = docService.writeDoc(repoPath, relativePath, alphaStart, alphaEnd, "documents alpha");
      const { recordId: betaRecordId } = docService.writeDoc(repoPath, relativePath, betaStart, betaEnd, "documents beta");

      const bothRenamedCode = twinCode.replace("function alpha(", "function alphaRenamed(").replace("function beta(", "function betaRenamed(");
      writeFileSync(join(repoPath, relativePath), bothRenamedCode);

      const report = docService.checkFile(repoPath, relativePath);
      const alphaDrift = report.driftResults.find((d) => d.recordId === alphaRecordId);
      const betaDrift = report.driftResults.find((d) => d.recordId === betaRecordId);

      expect(alphaDrift?.status).toBe("partially_stale");
      expect(betaDrift?.status).toBe("partially_stale");
      // Never wrong is the bar, not "correctly located" -- there is no
      // reliable position data left to locate either one by.
      expect(alphaDrift!.matchingRanges).toEqual([]);
      expect(betaDrift!.matchingRanges).toEqual([]);
    });

    // Phase A of a real, user-proposed design (2026-08-12): silently
    // leaving matchingRanges empty is honest, but tells a user nothing --
    // finding out why requires reading raw storage JSON, which "not
    // everyone wants to" do. When emptiness is specifically because of a
    // genuine collision (not because nothing survived at all), the message
    // should say so, name what it collides with, and point at the actual
    // resolution mechanism (the "Delete stale documentation" Quick Fix)
    // rather than leaving the user to guess what to do next.
    it("explains a genuine collision by name in the warning text, rather than staying silent about why the location is unknown", () => {
      const twinCode = `function alpha(a, b) {\n  return a + b;\n}\n\nfunction beta(a, b) {\n  return a + b;\n}\n`;
      writeFileSync(join(repoPath, relativePath), twinCode);

      const alphaStart = 0;
      const alphaEnd = twinCode.indexOf("\n\nfunction beta") + 1;
      const betaStart = twinCode.indexOf("function beta");
      const betaEnd = twinCode.length;

      docService.writeDoc(repoPath, relativePath, alphaStart, alphaEnd, "documents alpha");
      const { recordId: betaRecordId } = docService.writeDoc(repoPath, relativePath, betaStart, betaEnd, "documents beta");

      const bothRenamedCode = twinCode.replace("function alpha(", "function alphaRenamed(").replace("function beta(", "function betaRenamed(");
      writeFileSync(join(repoPath, relativePath), bothRenamedCode);

      const report = docService.checkFile(repoPath, relativePath);
      const messages = docService.generateMessages(repoPath, relativePath, report);
      const betaMessage = messages.find((m) => m.recordId === betaRecordId);

      expect(betaMessage?.text).toContain("alphaRenamed");
      expect(betaMessage?.text).toContain("betaRenamed");
      expect(betaMessage?.text).toContain("Delete stale documentation");
    });

    // Real distinction found via manual testing (2026-08-12): deleting a
    // colliding sibling's record, by itself, does NOT resolve the
    // survivor's own ambiguity -- the collision is rooted in the actual
    // source code being structurally identical, not in competing records
    // existing, and deleting a record never touches the code. Confirmed
    // directly: matchingRanges/findStaleRecordForSelection stay exactly as
    // ambiguous after a plain delete as before it.
    it("deleting one of two colliding records does NOT, by itself, resolve the survivor's ambiguity", () => {
      const twinCode = `function alpha(a, b) {\n  return a + b;\n}\n\nfunction beta(a, b) {\n  return a + b;\n}\n`;
      writeFileSync(join(repoPath, relativePath), twinCode);

      const alphaStart = 0;
      const alphaEnd = twinCode.indexOf("\n\nfunction beta") + 1;
      const betaStart = twinCode.indexOf("function beta");
      const betaEnd = twinCode.length;

      const { recordId: alphaRecordId } = docService.writeDoc(repoPath, relativePath, alphaStart, alphaEnd, "documents alpha");
      const { recordId: betaRecordId } = docService.writeDoc(repoPath, relativePath, betaStart, betaEnd, "documents beta");

      const bothRenamedCode = twinCode.replace("function alpha(", "function alphaRenamed(").replace("function beta(", "function betaRenamed(");
      writeFileSync(join(repoPath, relativePath), bothRenamedCode);

      docService.deleteRecord(repoPath, relativePath, alphaRecordId);

      const after = docService.checkFile(repoPath, relativePath);
      const betaDriftAfter = after.driftResults.find((d) => d.recordId === betaRecordId);
      expect(betaDriftAfter?.matchingRanges).toEqual([]);

      const betaRenamedStart = bothRenamedCode.indexOf("function betaRenamed");
      const betaRenamedEnd = bothRenamedCode.length;
      expect(docService.findStaleRecordForSelection(repoPath, relativePath, betaRenamedStart, betaRenamedEnd)).toBeNull();
    });

    // The real trigger, confirmed directly: freshly documenting ONE
    // colliding twin (not deleting a sibling) is what can resolve the
    // OTHER, still-ambiguous sibling -- the fresh record is a perfect,
    // unambiguous match for its own current code, so the shared-pool
    // resolution (most-intact record first) claims its position and
    // removes it from the pool, leaving the untouched sibling's old
    // record with only one remaining place its shared structure could be.
    it("freshly documenting one colliding twin can resolve the OTHER, still-ambiguous sibling's own old record", () => {
      const twinCode = `function alpha(a, b) {\n  return a + b;\n}\n\nfunction beta(a, b) {\n  return a + b;\n}\n`;
      writeFileSync(join(repoPath, relativePath), twinCode);

      const alphaStart = 0;
      const alphaEnd = twinCode.indexOf("\n\nfunction beta") + 1;
      const betaStart = twinCode.indexOf("function beta");
      const betaEnd = twinCode.length;

      const { recordId: alphaRecordId } = docService.writeDoc(repoPath, relativePath, alphaStart, alphaEnd, "documents alpha");
      const { recordId: betaRecordId } = docService.writeDoc(repoPath, relativePath, betaStart, betaEnd, "documents beta");

      const bothRenamedCode = twinCode.replace("function alpha(", "function alphaRenamed(").replace("function beta(", "function betaRenamed(");
      writeFileSync(join(repoPath, relativePath), bothRenamedCode);

      docService.deleteRecord(repoPath, relativePath, alphaRecordId);

      const alphaRenamedStart = bothRenamedCode.indexOf("function alphaRenamed");
      const alphaRenamedEnd = bothRenamedCode.indexOf("\n\nfunction betaRenamed") + 1;
      docService.writeDoc(repoPath, relativePath, alphaRenamedStart, alphaRenamedEnd, "documents alphaRenamed, fresh");

      const after = docService.checkFile(repoPath, relativePath);
      const betaDriftAfter = after.driftResults.find((d) => d.recordId === betaRecordId);
      expect(betaDriftAfter?.matchingRanges.length).toBeGreaterThan(0);

      const betaRenamedStart = bothRenamedCode.indexOf("function betaRenamed");
      const betaRenamedEnd = bothRenamedCode.length;
      expect(docService.findStaleRecordForSelection(repoPath, relativePath, betaRenamedStart, betaRenamedEnd)?.recordId).toBe(betaRecordId);
    });

    // Real user feedback: a docText-quote subject like "greet() builds and
    // logs a greeting." doesn't help locate the code. When the record still
    // has unchanged members to anchor from, the warning should name the
    // actual code element instead -- here, the still-current `greet`
    // function that contains them.
    it("uses the record's current, real name as the warning subject when one can be derived", () => {
      docService.writeDoc(repoPath, relativePath, 0, 84, "greet() builds and logs a greeting.");
      writeFileSync(join(repoPath, relativePath), renamedCode);

      const report = docService.checkFile(repoPath, relativePath);
      const drift = report.driftResults[0];
      expect(drift.name).toBe("greet");

      const messages = docService.generateMessages(repoPath, relativePath, report);
      const warning = messages.find((m) => m.severity === "warning");
      expect(warning?.text).toContain('"greet"');
      expect(warning?.text).not.toContain("greet() builds and logs a greeting.");
      // Carries the record it's about, so a UI can act on this exact record
      // (e.g. offer to delete it) without having to guess from the text.
      expect(warning?.recordId).toBe(drift.recordId);
    });

    it("falls back to the docText quote when a record is fully stale and no current name can be derived", () => {
      // Every member changed -- there's no unchanged anchor left in the
      // current file to derive a name from, so this must stay null and the
      // message must fall back to quoting the stored docText, same as before.
      docService.writeDoc(repoPath, relativePath, 0, 84, "greet() builds and logs a greeting.");
      writeFileSync(join(repoPath, relativePath), `const totallyDifferent = 42;\n`);

      const report = docService.checkFile(repoPath, relativePath);
      const drift = report.driftResults[0];
      expect(drift.status).toBe("fully_stale");
      expect(drift.name).toBeNull();

      const messages = docService.generateMessages(repoPath, relativePath, report);
      const error = messages.find((m) => m.severity === "error");
      expect(error?.text).toContain('"greet() builds and logs a greeting."');
      expect(error?.recordId).toBe(drift.recordId);
    });

    it("classifies a record as fully stale, not partially stale, when the only surviving 'matches' are coincidental bare-leaf hash collisions", () => {
      // Real bug found against an actual repo, not a toy fixture: a record
      // documenting code that was later replaced by completely UNRELATED
      // code still reported "partially stale" instead of "fully stale" --
      // because a handful of its members were bare leaves (a NumericLiteral
      // `1`, a `TSNumberKeyword`) that happened to also appear, meaning
      // something entirely different, somewhere else in the new code.
      // Hashing has no notion of position, so `currentHashes.has(hash)`
      // can't tell "this is genuinely the same content" apart from "this
      // digit/keyword is just common." Fixed by requiring at least one
      // surviving COMPOUND member (a real structural anchor) before trusting
      // any leaf-level match at all -- with zero compound survivors here,
      // every member, including the coincidental leaf matches, must count as
      // changed.
      const fnPath = "unrelated.js";
      const original = `function fib(n) {
  if (n <= 1) {
    return n;
  }
  return fib(n - 1) + fib(n - 2);
}
`;
      writeFileSync(join(repoPath, fnPath), original);
      docService.writeDoc(repoPath, fnPath, 0, original.length, "Computes fibonacci recursively.");

      // Entirely different purpose and shape -- shares no real structure with
      // the original at all, but does reuse the bare literal `1`.
      const replacement = `function buildGraph(edges) {
  const graph = {};
  for (const [from, to] of edges) {
    graph[from] = (graph[from] || 0) + 1;
  }
  return graph;
}
`;
      writeFileSync(join(repoPath, fnPath), replacement);

      const report = docService.checkFile(repoPath, fnPath);
      const drift = report.driftResults[0];
      expect(drift.status).toBe("fully_stale");
      expect(drift.changedMembers.length).toBe(drift.totalMembers);

      const messages = docService.generateMessages(repoPath, fnPath, report);
      const error = messages.find((m) => m.severity === "error");
      expect(error?.text).toContain('"Computes fibonacci recursively."');
      expect(messages.find((m) => m.severity === "warning")).toBeUndefined();
    });

    it("classifies an untouched record as unchanged even when it's made ENTIRELY of leaf members (e.g. documenting a bare comment)", () => {
      // Real bug found via manual testing: the fix above requires at least
      // one surviving COMPOUND member before trusting any leaf match -- but
      // a record can be made entirely of leaf content, with no compound
      // member to offer AT ALL, by its own composition (a lone comment has
      // no substructure -- it's always a leaf). Requiring a compound anchor
      // that can never exist unconditionally marked such a record fully
      // stale, even when genuinely nothing had changed, contradicting
      // findDocumentedNodes (used by the Documented-sections sidebar), which
      // correctly found the exact, untouched match via a completely
      // different, unrelated computation.
      const commentPath = "commented.js";
      const code = `// Run-length encoding utilities: compress and decompress a string.
function noop() {}
`;
      writeFileSync(join(repoPath, commentPath), code);

      const commentEnd = code.indexOf("\n");
      const { recordId } = docService.writeDoc(repoPath, commentPath, 0, commentEnd, "documenting the comment");

      // Nothing on disk changes at all before checking.
      const report = docService.checkFile(repoPath, commentPath);
      const drift = report.driftResults.find((d) => d.recordId === recordId);

      expect(drift?.status).toBe("unchanged");
      expect(drift?.changedMembers).toEqual([]);
    });

    it("still derives the real name when the function's own identifier is reused at an unrelated call site", () => {
      // Real bug found testing against an actual repo (not just a toy
      // fixture): hashing is position-invariant, so a function's own name
      // and a later CALL to that same function are two separate Identifier
      // nodes with an IDENTICAL hash. The first version of the name-derivation
      // fix treated every unchanged-hash match as an anchor, including bare
      // leaves -- so the call site's identifier (far past the function's own
      // closing brace) stretched the bounding box out past any node that
      // could contain it, and `name` came back null instead of the function's
      // real name. Fixed by restricting anchors to compound nodes only, same
      // as the undocumented-node overlap check already does.
      const fnPath = "withCallSite.js";
      const original = `function computeTotal(count) {
  const numbers = [];
  for (let i = 0; i < count; i++) {
    numbers.push(i);
  }
  return numbers;
}

const result = computeTotal(20);
console.log(result);
`;
      writeFileSync(join(repoPath, fnPath), original);
      docService.writeDoc(repoPath, fnPath, 0, original.indexOf("\n\n"), "Computes a running total.");

      const edited = original.replace("let i = 0", "let i = 1").replace("numbers.push(i)", "numbers.push(i * 2)");
      writeFileSync(join(repoPath, fnPath), edited);

      const report = docService.checkFile(repoPath, fnPath);
      const drift = report.driftResults[0];
      expect(drift.status).toBe("partially_stale");
      expect(drift.name).toBe("computeTotal");
    });

    it("does not repeat a container as 'undocumented' when it only changed because something inside it was renamed", () => {
      // Real bug found via manual testing: adding genuinely NEW code to an
      // already-documented, now-partially-stale function only ever produced
      // "the whole function has no documentation," never anything naming
      // the new addition specifically -- because the changed container
      // (FunctionDeclaration) swallowed its own genuinely-new child during
      // collapseToTopLevel. Verifies the fix directly: the container itself
      // must never appear as its own "has no documentation" message when
      // the drift warning already covers it.
      docService.writeDoc(repoPath, relativePath, 0, 84, "greet() builds and logs a greeting.");
      writeFileSync(join(repoPath, relativePath), renamedCode);

      const report = docService.checkFile(repoPath, relativePath);
      const messages = docService.generateMessages(repoPath, relativePath, report);
      const infoMessages = messages.filter((m) => m.severity === "info");

      expect(infoMessages.some((m) => m.text.includes("FunctionDeclaration"))).toBe(false);
      expect(infoMessages.some((m) => m.text.includes("BlockStatement"))).toBe(false);
    });

    it("names the specific new addition when genuinely new code is added alongside existing content", () => {
      const fibPath = "fib.js";
      const original = `function fib(n) {
  if (n <= 1) {
    return n;
  }
  return fib(n - 1) + fib(n - 2);
}
`;
      writeFileSync(join(repoPath, fibPath), original);
      docService.writeDoc(repoPath, fibPath, 0, original.length, "Computes fibonacci.");

      // A genuinely NEW branch, not a rename of anything that existed
      // before -- has no relationship at all to the original record.
      const withNewBranch = `function fib(n) {
  if (n <= 1) {
    return n;
  }
  if (n === 2) {
    return 1;
  }
  return fib(n - 1) + fib(n - 2);
}
`;
      writeFileSync(join(repoPath, fibPath), withNewBranch);

      const report = docService.checkFile(repoPath, fibPath);
      const messages = docService.generateMessages(repoPath, fibPath, report);
      const infoMessages = messages.filter((m) => m.severity === "info");

      expect(infoMessages.some((m) => m.text.includes("FunctionDeclaration"))).toBe(false);
      expect(infoMessages.some((m) => m.text.includes("IfStatement"))).toBe(true);
    });

    // Real user feedback: "A VariableDeclaration near line 6" doesn't say
    // WHICH variable -- the underlying AST node's own identifier is
    // available and was just being discarded before reaching the message.
    it("names the function and variable in undocumented-node messages when a real name exists", () => {
      const report = docService.checkFile(repoPath, relativePath);
      const messages = docService.generateMessages(repoPath, relativePath, report);
      const infoMessages = messages.filter((m) => m.severity === "info");

      const functionMessage = infoMessages.find((m) => m.text.includes("FunctionDeclaration"));
      const variableMessage = infoMessages.find((m) => m.text.includes("VariableDeclaration"));

      expect(functionMessage?.text).toBe('FunctionDeclaration "greet" near line 1 has no documentation yet.');
      expect(variableMessage?.text).toBe('VariableDeclaration "x" near line 6 has no documentation yet.');
      // An undocumented-node message isn't about any stored record at all --
      // there's nothing to delete, so this must stay null, not a guess.
      expect(functionMessage?.recordId).toBeNull();
    });

    it("falls back to the generic type-only phrasing when a node has no name of its own", () => {
      // An anonymous callback has no identifier at all -- the fallback
      // phrasing must still apply, not throw or produce `undefined`/`null`
      // in the message text.
      writeFileSync(join(repoPath, relativePath), `setTimeout(function () {\n  console.log("tick");\n}, 1000);\n`);

      const report = docService.checkFile(repoPath, relativePath);
      const messages = docService.generateMessages(repoPath, relativePath, report);
      const topLevelMessage = messages.find((m) => m.text.includes("ExpressionStatement"));

      expect(topLevelMessage?.text).toMatch(/^A ExpressionStatement near line \d+ has no documentation yet\.$/);
    });
  });

  describe("Message.ranges -- click-to-highlight position data", () => {
    it("gives a warning message one range per surviving anchor, ready to highlight on demand", () => {
      docService.writeDoc(repoPath, relativePath, 0, 84, "greet() builds and logs a greeting.");
      writeFileSync(join(repoPath, relativePath), renamedCode);

      const report = docService.checkFile(repoPath, relativePath);
      const messages = docService.generateMessages(repoPath, relativePath, report);
      const warning = messages.find((m) => m.severity === "warning");

      // The rename fixture has exactly two surviving compound anchors
      // (BinaryExpression, MemberExpression) -- confirmed directly earlier
      // against this same fixture.
      expect(warning?.ranges.length).toBe(2);
      for (const range of warning?.ranges ?? []) {
        expect(range.end).toBeGreaterThan(range.start);
      }

      // Each info message carries its own single node's exact position.
      const infoMessages = messages.filter((m) => m.severity === "info");
      expect(infoMessages.every((m) => m.ranges.length === 1)).toBe(true);
    });

    it("gives a fully-stale error message no ranges at all -- there is no current code left to point at", () => {
      docService.writeDoc(repoPath, relativePath, 0, 84, "greet() builds and logs a greeting.");
      writeFileSync(join(repoPath, relativePath), `const totallyDifferent = 42;\n`);

      const report = docService.checkFile(repoPath, relativePath);
      const messages = docService.generateMessages(repoPath, relativePath, report);
      const error = messages.find((m) => m.severity === "error");

      expect(error?.ranges).toEqual([]);
    });
  });
});
