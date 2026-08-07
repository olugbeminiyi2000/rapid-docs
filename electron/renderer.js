// Standard non-bundler Monaco worker setup -- without this, Monaco tries
// to spin up a Worker for language services (TS diagnostics, JSON/CSS/
// HTML) and throws "You must define MonacoEnvironment.getWorkerUrl"
// the moment a document actually needs one. Paths confirmed to exist by
// directly inspecting node_modules/monaco-editor/min/vs, not assumed
// from an older version's docs -- this build still ships the classic
// per-language worker files alongside its newer hashed-bundle ones.
self.MonacoEnvironment = {
  getWorkerUrl: function (moduleId, label) {
    if (label === "json") return "vs/language/json/json.worker.js";
    if (label === "css" || label === "scss" || label === "less") return "vs/language/css/css.worker.js";
    if (label === "html" || label === "handlebars" || label === "razor") return "vs/language/html/html.worker.js";
    if (label === "typescript" || label === "javascript") return "vs/language/typescript/ts.worker.js";
    return "vs/editor/editor.worker.js";
  },
};

require.config({ paths: { vs: "vs" } });
require(["vs/editor/editor.main"], main);

// Minimal line-style icons (stroke="currentColor", no fill) -- plain inline
// SVG strings, no icon-font or library dependency. Reused for both static
// markup (top bar, built once below) and rows built dynamically at runtime
// (documented-sections, archive) via string interpolation.
const ICONS = {
  edit:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path></svg>',
  delete:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>',
  discard:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
  attach:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5 12.5 20a4.5 4.5 0 0 1-6.36-6.36L14.5 5.3a3 3 0 0 1 4.24 4.24L10.4 18a1.5 1.5 0 0 1-2.12-2.12l7.07-7.07"></path></svg>',
  folder:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"></path></svg>',
  spinner:
    '<svg class="icon-spin" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle><path d="M12 2a10 10 0 0 1 10 10"></path></svg>',
  menu:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"></line><line x1="4" y1="12" x2="20" y2="12"></line><line x1="4" y1="18" x2="20" y2="18"></line></svg>',
};

// Icons in static markup (nav rail, top bar) are placeholders (<span
// data-icon="name">) rather than duplicated SVG strings -- one source of
// truth in ICONS above. Runs immediately (doesn't wait for Monaco's
// require() callback below, since icons have nothing to do with it).
for (const el of document.querySelectorAll("[data-icon]")) {
  el.innerHTML = ICONS[el.dataset.icon] || "";
}

// Set once Monaco's editor is created inside main() below -- read later by
// loadActiveRepoPath's own layout-recompute fix, since Monaco was created
// while #app-body could still have been hidden (no repo active yet), and
// simply revealing it afterward doesn't reliably trigger Monaco's own
// automaticLayout polling on its own.
let editorInstance = null;

function main() {
  // Monaco renders independently of the page's own CSS, so it can't read the
  // --bg/--blue/etc custom properties in styles.css -- these hex values are
  // deliberately the same ones defined there, kept in sync by hand since
  // that's the one real seam between the two theming systems. Restrained to
  // UI chrome colors (background, gutter, cursor, selection, line numbers),
  // not a full custom syntax palette -- Monaco's stock token colors are
  // already well-tested, and rewriting them risked looking worse for very
  // little coordination gain over just tying the surrounding chrome together.
  monaco.editor.defineTheme("rapid-docs-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#ffffff",
      "editorGutter.background": "#ffffff",
      "editorLineNumber.foreground": "#666666",
      "editorLineNumber.activeForeground": "#2166ac",
      "editor.lineHighlightBackground": "#eeeeee",
      "editorCursor.foreground": "#2166ac",
      "editor.selectionBackground": "#2166ac33",
    },
  });
  monaco.editor.defineTheme("rapid-docs-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#1e1e1e",
      "editorGutter.background": "#1e1e1e",
      "editorLineNumber.foreground": "#9a9a9a",
      "editorLineNumber.activeForeground": "#6ea8dc",
      "editor.lineHighlightBackground": "#2a2d2e",
      "editorCursor.foreground": "#6ea8dc",
      "editor.selectionBackground": "#6ea8dc33",
    },
  });

  const editor = monaco.editor.create(document.getElementById("file-content-editor"), {
    value: "",
    language: "plaintext",
    readOnly: true,
    automaticLayout: true,
    theme: "rapid-docs-light",
    minimap: { enabled: false },
    // Monaco's built-in context menu (Go to Definition, Peek, Command
    // Palette) assumes a full language server -- none of it applies here.
    // Replaced entirely with a small custom one built from what rapid-docs
    // actually does, wired up below.
    contextmenu: false,
  });
  editorInstance = editor;

  let currentModel = null;
  let currentRelativePath = null;
  let currentFileContent = "";
  let currentDocumentedSections = [];
  let decorationIds = [];
  // Every file currently open as a tab, in tab-strip order (most-recently
  // opened appended to the end, never reordered on activation -- matches
  // how VS Code's own tabs behave by default). currentRelativePath (above)
  // is still the single source of truth for which ONE is active; this is
  // purely "what else is open," so Problems/Documented-sections keep
  // reacting to whichever tab is active exactly as they always have.
  let openTabs = [];

  // Set only by right-click "Update documentation (code changed)" on a
  // partially-stale selection -- redirects the NEXT write-doc-button
  // submission to updateDriftedDoc (replace the old, drifted record)
  // instead of writeDoc (create a new, unrelated one). null the rest of the
  // time, which is what keeps "Document Selection" behaving exactly as
  // before for the ordinary, no-drift-involved case.
  let pendingDriftUpdate = null; // { oldRecordId: string } | null

  // Drift highlighting is deliberately NOT automatic -- real feedback: an
  // always-on blue/orange tint over every problem in the file at once was
  // more noise than help, and impossible to control. Instead, nothing is
  // highlighted until a specific Problems row is clicked, and then only
  // THAT row's own ranges light up. activeHighlight is null when nothing is
  // selected; otherwise the key identifies which message (see problemKey)
  // is currently shown, so clicking it again toggles it off, and a live
  // recheck can tell whether the same problem still exists.
  let activeHighlight = null; // { key: string, severity: string, ranges: {start,end}[] } | null

  function languageForPath(relativePath) {
    if (/\.(ts|tsx|mts|cts)$/.test(relativePath)) return "typescript";
    if (/\.(js|jsx|mjs|cjs)$/.test(relativePath)) return "javascript";
    return "plaintext";
  }

  function lineNumberAt(content, offset) {
    return content.slice(0, offset).split("\n").length;
  }

  function getSelectionOffsets() {
    const model = editor.getModel();
    if (!model) return { start: 0, end: 0 };
    const sel = editor.getSelection();
    return {
      start: model.getOffsetAt(sel.getStartPosition()),
      end: model.getOffsetAt(sel.getEndPosition()),
    };
  }

  function selectByOffsets(start, end) {
    const model = editor.getModel();
    if (!model) return;
    const startPos = model.getPositionAt(start);
    const endPos = model.getPositionAt(end);
    const range = new monaco.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column);
    editor.setSelection(range);
    editor.revealRangeInCenter(range);
    editor.focus();
  }

  // Real inline highlighting of documented regions -- the whole reason
  // Monaco replaced the plain textarea. A background tint per
  // documented span, painted via deltaDecorations rather than any DOM
  // text styling (which a plain textarea could never do at all).
  function rangeDecoration(range, className) {
    const model = editor.getModel();
    const startPos = model.getPositionAt(range.start);
    const endPos = model.getPositionAt(range.end);
    return {
      range: new monaco.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column),
      options: { inlineClassName: className },
    };
  }

  const HIGHLIGHT_CLASS_BY_SEVERITY = {
    documented: "documented-region-decoration",
    warning: "warning-region-decoration",
    info: "undocumented-region-decoration",
  };

  // Nothing is highlighted by default at all -- not drift, and not (real
  // feedback) "documented" either: once a piece of code is documented, its
  // own row in the Documented sections list already shows that, so a
  // permanent green tint on the code itself was redundant, and made it
  // impossible to see the actual code underneath. At most ONE thing is ever
  // highlighted at a time, whichever row (Problems or Documented sections)
  // was clicked most recently -- see toggleHighlight / toggleDocSectionHighlight.
  function renderDecorations() {
    const model = editor.getModel();
    if (!model) return;

    const newDecorations = activeHighlight
      ? activeHighlight.ranges.map((range) => rangeDecoration(range, HIGHLIGHT_CLASS_BY_SEVERITY[activeHighlight.severity]))
      : [];

    decorationIds = editor.deltaDecorations(decorationIds, newDecorations);
  }

  // Clicking directly inside a documented region's highlighted text jumps
  // to (selects + reveals) that exact region -- the inline equivalent of
  // clicking its row in the documented-sections list. Deliberately on
  // mouseUP, only when the resulting selection is still EMPTY (a plain
  // click, not a drag): doing this on mouseDown instead hijacked the START
  // of every drag, making it impossible to drag-select a smaller child
  // region inside an already-documented parent -- the click beginning the
  // drag always snapped to the parent's full bounds first, before the drag
  // could even happen. A real drag-selection, even one entirely inside a
  // documented region, is left exactly as selected now.
  editor.onMouseUp((event) => {
    if (!event.target || !event.target.position) return;
    const model = editor.getModel();
    const selection = editor.getSelection();
    if (!model || !selection || !selection.isEmpty()) return;

    const offset = model.getOffsetAt(event.target.position);
    const candidates = currentDocumentedSections.filter(
      (section) => offset >= section.start && offset <= section.end
    );
    if (candidates.length === 0) return;

    // Prefer the smallest (most specific/innermost) match when several
    // documented regions overlap here -- e.g. a documented if-block nested
    // inside a documented function -- since the innermost one is almost
    // always what a click at this exact point actually means.
    const hit = candidates.reduce((smallest, candidate) =>
      candidate.end - candidate.start < smallest.end - smallest.start ? candidate : smallest
    );
    selectByOffsets(hit.start, hit.end);
  });

  async function copySelectedText() {
    const model = editor.getModel();
    const selection = editor.getSelection();
    if (!model || !selection) return;
    await navigator.clipboard.writeText(model.getValueInRange(selection));
  }

  function hideContextMenu() {
    const existing = document.getElementById("custom-context-menu");
    if (existing) existing.remove();
  }

  function showContextMenu(x, y, items) {
    hideContextMenu();
    const menu = document.createElement("div");
    menu.id = "custom-context-menu";
    menu.className = "custom-context-menu";
    menu.style.left = x + "px";
    menu.style.top = y + "px";

    for (const item of items) {
      const button = document.createElement("button");
      // item.shortcut is optional -- the right-click context menu never
      // uses it (its actions have no keyboard equivalent), only the
      // top-bar menu does. Kept as two separate spans, not one text node,
      // so CSS can push the shortcut hint to the right independently of
      // however long the label itself happens to be.
      if (item.shortcut) {
        button.innerHTML = '<span class="menu-item-label"></span><span class="menu-item-shortcut"></span>';
        button.querySelector(".menu-item-label").textContent = item.label;
        button.querySelector(".menu-item-shortcut").textContent = item.shortcut;
      } else {
        button.textContent = item.label;
      }
      button.addEventListener("click", (clickEvent) => {
        clickEvent.stopPropagation();
        hideContextMenu();
        item.onClick();
      });
      menu.appendChild(button);
    }

    document.body.appendChild(menu);

    // Clamp to the viewport -- appended first so getBoundingClientRect()
    // reflects the menu's REAL rendered size, not a guess. Real bug found
    // via manual testing: the top-bar menu button always sits in the
    // top-right corner, so its dropdown opened straight off the right edge
    // of the window, clipped rather than fully visible -- the plain
    // right-click context menu was always exposed to the same risk near an
    // edge, just less likely to actually get clicked there.
    const rect = menu.getBoundingClientRect();
    const margin = 12;
    if (rect.right > window.innerWidth) {
      menu.style.left = Math.max(margin, window.innerWidth - rect.width - margin) + "px";
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = Math.max(margin, window.innerHeight - rect.height - margin) + "px";
    }
  }

  document.addEventListener("click", hideContextMenu);
  document.addEventListener("scroll", hideContextMenu, true);
  // Every real context menu (OS-native or in-app) dismisses on Escape --
  // this one didn't yet. Registered on the CAPTURE phase deliberately, not
  // the default bubble phase: confirmed via real testing that Monaco's own
  // internal keyboard handling (on its hidden edit-context element) calls
  // stopPropagation() on Escape, which meant a bubble-phase listener on
  // document never received it at all when the editor had focus.
  document.addEventListener(
    "keydown",
    (keyEvent) => {
      if (keyEvent.key === "Escape") hideContextMenu();
    },
    { capture: true }
  );

  // Built from what rapid-docs actually does with a selection, not a
  // generic file-menu: matches an existing documented record -> edit/delete
  // it; a new, undocumented selection -> document it; either way, Copy
  // stays available since it's plain clipboard access, not an editing
  // capability the "not a code editor" boundary needs to exclude.
  //
  // Async and backend-authoritative on purpose -- not a client-side check
  // against currentDocumentedSections' reported start/end. Real bug found
  // via manual testing: a genuine drag-selection almost never lands exactly
  // on an AST node's precise character boundary (it commonly starts a
  // little early, on the statement's leading indent), so position equality
  // against a record's reported node boundary wrongly said "no match" for
  // selections writeDoc itself would recognize as an exact duplicate.
  // findRecordForSelection runs the SAME structural, contains-based
  // computation writeDoc uses, so the two can never disagree again.
  document.getElementById("file-content-editor").addEventListener("contextmenu", async (domEvent) => {
    domEvent.preventDefault();

    const { start, end } = getSelectionOffsets();
    const hasSelection = start !== end;
    const matchingRecord =
      currentRelativePath !== null && hasSelection
        ? await window.rapidDocs.findRecordForSelection(currentRelativePath, start, end)
        : null;

    // Only reachable once matchingRecord comes back null: an EXACT hash
    // match (matchingRecord) can only ever exist for genuinely unchanged
    // code, by construction -- a drifted record's hash can never equal a
    // fresh computation over current code again. So this is never checked,
    // and never shown, for the same selection matchingRecord already
    // covers; nothing about the Edit/Delete path above changes.
    const staleRecord =
      currentRelativePath !== null && hasSelection && !matchingRecord
        ? await window.rapidDocs.findStaleRecordForSelection(currentRelativePath, start, end)
        : null;

    const items = [];

    if (matchingRecord) {
      items.push({
        label: "Edit documentation",
        onClick: () => {
          clearDriftUpdateMode();
          editSectionFromContextMenu(matchingRecord);
        },
      });
      items.push({
        label: "Delete documentation",
        onClick: () => {
          clearDriftUpdateMode();
          deleteSection(matchingRecord);
        },
      });
    } else if (hasSelection) {
      if (staleRecord) {
        items.push({
          label: "Update documentation (code changed)",
          onClick: () => beginDriftUpdate(staleRecord),
        });
      }
      items.push({
        label: "Document selection",
        onClick: () => {
          clearDriftUpdateMode();
          document.getElementById("doc-text-input").focus();
        },
      });
    }

    if (hasSelection) {
      items.push({ label: "Copy", onClick: () => copySelectedText() });
    }

    if (items.length > 0) {
      showContextMenu(domEvent.clientX, domEvent.clientY, items);
    }
  });

  // Turns a flat list of relative paths ("src/nested/deep.js") into a real
  // nested tree -- the file list was previously just that flat list
  // rendered as one row per full path, with no folder structure at all.
  // Folder nodes get their own accumulated relativePath too (not just
  // files) -- their only use is as a stable identity for remembering
  // collapsed state across a rebuild (see collapsedFolderPaths below), but
  // without it a folder had no identity distinct from "whatever's currently
  // sitting at this DOM position," which a rebuild throws away entirely.
  function buildFileTree(relativePaths) {
    const root = { name: "", children: new Map() };

    for (const relativePath of relativePaths) {
      const parts = relativePath.split("/");
      let node = root;
      let folderPath = "";

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const isFile = i === parts.length - 1;
        folderPath = folderPath === "" ? part : `${folderPath}/${part}`;

        if (!node.children.has(part)) {
          node.children.set(
            part,
            isFile
              ? { name: part, relativePath, isFile: true }
              : { name: part, relativePath: folderPath, children: new Map() }
          );
        }

        node = node.children.get(part);
      }
    }

    return root;
  }

  // Every rebuild (loadFileList runs on every file open, not just repo
  // switches) used to throw away which folders were collapsed -- nothing
  // remembered it anywhere except the DOM elements about to be discarded.
  // Real bug found via manual testing: collapsing everything except the
  // folder you're working in, then opening any file, silently re-expanded
  // every folder back to its default -- indistinguishable, from the
  // outside, from "clicking a file re-opens unrelated folders." Persisting
  // which folder PATHS are collapsed here (survives across rebuilds, keyed
  // by identity, not DOM position) is what actually fixes that.
  const collapsedFolderPaths = new Set();

  // Folders first, then files, each alphabetical -- the common convention
  // in most file explorers. Folders default to expanded (real repos here
  // are small enough that collapsing everything by default would hide more
  // than it helps); clicking a folder's header toggles it.
  function renderFileTree(node, container) {
    const folders = [];
    const files = [];
    for (const child of node.children.values()) {
      (child.isFile ? files : folders).push(child);
    }
    folders.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));

    for (const folder of folders) {
      const folderEl = document.createElement("div");
      folderEl.className = "tree-folder";

      const headerEl = document.createElement("div");
      headerEl.className = "tree-folder-header";
      headerEl.textContent = folder.name;

      const childrenEl = document.createElement("div");
      childrenEl.className = "tree-children";

      const isCollapsed = collapsedFolderPaths.has(folder.relativePath);
      childrenEl.classList.toggle("collapsed", isCollapsed);
      headerEl.classList.toggle("collapsed", isCollapsed);

      headerEl.addEventListener("click", () => {
        const nowCollapsed = childrenEl.classList.toggle("collapsed");
        headerEl.classList.toggle("collapsed", nowCollapsed);
        if (nowCollapsed) {
          collapsedFolderPaths.add(folder.relativePath);
        } else {
          collapsedFolderPaths.delete(folder.relativePath);
        }
      });

      folderEl.appendChild(headerEl);
      folderEl.appendChild(childrenEl);
      renderFileTree(folder, childrenEl);
      container.appendChild(folderEl);
    }

    for (const file of files) {
      const fileEl = document.createElement("div");
      fileEl.className = "tree-file";
      if (file.relativePath === currentRelativePath) fileEl.classList.add("active");
      fileEl.textContent = file.name;
      fileEl.addEventListener("click", () => openFile(file.relativePath));
      container.appendChild(fileEl);
    }
  }

  async function loadFileList() {
    let files;
    try {
      files = await window.rapidDocs.listFiles();
    } catch (err) {
      addActivityEntry("error", friendlyErrorMessage(err));
      files = [];
    }
    const listEl = document.getElementById("file-list");
    listEl.innerHTML = "";
    renderFileTree(buildFileTree(files), listEl);
  }

  async function openFile(relativePath) {
    let content;
    try {
      content = await window.rapidDocs.readFile(relativePath);
    } catch (err) {
      // The file may have been deleted or renamed in the exact moment it
      // was clicked -- a real, plausible race during live-watching, not a
      // hypothetical. Real bug found via manual testing (Objective 3.42):
      // leaving this uncaught here left Monaco, Problems, and the sidebar
      // all silently showing the PREVIOUSLY open file with zero indication
      // anything went wrong. Nothing sensible to open into -- the next live
      // event's loadFileList() call already keeps the tree honest.
      addActivityEntry("error", `Could not open ${relativePath}: ${friendlyErrorMessage(err)}`);
      // If this was a re-activation of an already-open tab (its file just
      // vanished/renamed at the exact moment it was clicked), the tab
      // shouldn't linger in the strip pointing at nothing -- closeTab picks
      // a sensible fallback (or resets to "no file selected") the same way
      // it would for a deliberate close.
      if (openTabs.includes(relativePath)) await closeTab(relativePath);
      return;
    }

    // Every doc/drift feature in this app depends on being able to parse
    // the file at all -- opening one that can't be would just show inert
    // plain text in Monaco with Problems/Documented-sections silently doing
    // nothing for it. Refused here, before anything about the previously
    // open file is touched, rather than opening it and letting every panel
    // discover the failure separately (and inconsistently) on its own.
    let parseable;
    try {
      parseable = await window.rapidDocs.canParseFile(relativePath);
    } catch (err) {
      addActivityEntry("error", `Could not check ${relativePath}: ${friendlyErrorMessage(err)}`);
      return;
    }
    if (!parseable) {
      addActivityEntry("error", `${relativePath} could not be parsed and can't be opened here.`);
      if (openTabs.includes(relativePath)) await closeTab(relativePath);
      return;
    }

    if (!openTabs.includes(relativePath)) {
      openTabs.push(relativePath);
    }
    currentRelativePath = relativePath;
    currentFileContent = content;
    // Reveals #editor-area (hidden until a file is actually selected) and
    // returns the panel to its normal, non-expanded height -- done BEFORE
    // handing Monaco its new model, so the editor's container already has
    // real dimensions by the time layout happens, not a stale 0-height one.
    updatePanelLayout();

    if (currentModel) currentModel.dispose();
    currentModel = monaco.editor.createModel(content, languageForPath(relativePath));
    editor.setModel(currentModel);
    decorationIds = [];

    document.getElementById("current-file").textContent = relativePath;
    renderTabStrip();
    // A fresh look at a (possibly different) file -- whatever was
    // previously dismissed in Problems no longer applies to what's about to
    // be shown. Activity is deliberately NOT reset here: it's a log of this
    // session's Document Selection attempts, not per-file state.
    clearedProblemKeys.clear();
    selectedProblemKeys.clear();
    activeHighlight = null;
    await loadFileList();
    await refreshDocumentedSections();
    renderFileStatus();

    // Catches up whatever the bulk startup/reconcile scan deferred for this
    // specific file (a large, undocumented one -- see SyncService's
    // LARGE_FILE_THRESHOLD_BYTES) now that someone's actually looking at
    // it. A genuine no-op for every other file: the backend only does real
    // work here if it turns out this one was actually skipped, and any
    // resulting update arrives through the same messages:live path a live
    // edit already uses, so it's picked up automatically either way.
    try {
      await window.rapidDocs.ensureFileChecked(relativePath);
    } catch (err) {
      addActivityEntry("error", `Could not check ${relativePath}: ${friendlyErrorMessage(err)}`);
    }
  }

  // Draws the tab strip from openTabs/currentRelativePath -- rebuilt fresh
  // on every change rather than patched incrementally, same approach
  // loadFileList() already takes for the file tree, since the tab count
  // here is small enough that a full rebuild is never a real cost.
  function renderTabStrip() {
    const stripEl = document.getElementById("tab-strip");
    stripEl.innerHTML = "";

    for (const relativePath of openTabs) {
      const tabEl = document.createElement("div");
      tabEl.className = "editor-tab" + (relativePath === currentRelativePath ? " active" : "");
      tabEl.title = relativePath;
      tabEl.innerHTML =
        '<span class="tab-name"></span><button class="tab-close" title="Close">' + ICONS.discard + "</button>";
      tabEl.querySelector(".tab-name").textContent = lastPathSegment(relativePath);

      tabEl.addEventListener("click", () => openFile(relativePath));
      tabEl.querySelector(".tab-close").addEventListener("click", (clickEvent) => {
        clickEvent.stopPropagation();
        closeTab(relativePath);
      });
      // VS Code's own tab menu, minus "Close Saved" -- rapid-docs never
      // edits or saves files at all (read-only by design), so an
      // unsaved-changes concept has nothing to apply to here. Items that
      // wouldn't do anything (e.g. "Close Others" with only one tab open)
      // are left out entirely rather than shown disabled, since
      // showContextMenu has no notion of a disabled item.
      tabEl.addEventListener("contextmenu", (menuEvent) => {
        menuEvent.preventDefault();
        const tabIndex = openTabs.indexOf(relativePath);
        const items = [{ label: "Close", onClick: () => closeTab(relativePath) }];
        if (openTabs.length > 1) {
          items.push({ label: "Close Others", onClick: () => closeOthers(relativePath) });
        }
        if (tabIndex < openTabs.length - 1) {
          items.push({ label: "Close to the Right", onClick: () => closeToTheRight(relativePath) });
        }
        items.push({ label: "Close All", onClick: () => closeAll() });
        showContextMenu(menuEvent.clientX, menuEvent.clientY, items);
      });

      stripEl.appendChild(tabEl);
    }
  }

  // Shared by the tab's own close (x) button, every "Close..." context-menu
  // variant, and openFile's own failure paths (a tab whose file just failed
  // to read/parse -- deleted or renamed at the exact moment it was
  // reactivated -- shouldn't linger in the strip either). Only picks a
  // fallback tab to activate when the CLOSED tab was the active one;
  // closing a background tab never changes what's currently shown.
  async function closeTab(relativePath) {
    const index = openTabs.indexOf(relativePath);
    if (index === -1) return;
    const wasActive = currentRelativePath === relativePath;
    openTabs.splice(index, 1);

    if (!wasActive) {
      renderTabStrip();
      return;
    }
    if (openTabs.length === 0) {
      resetOpenFileState();
      return;
    }
    // Activate whatever was immediately to this tab's left, or the new
    // first tab if it was already leftmost -- matches VS Code's own default
    // behavior when closing the active tab.
    await openFile(openTabs[Math.max(0, index - 1)]);
  }

  async function closeOthers(relativePath) {
    openTabs = openTabs.filter((path) => path === relativePath);
    if (currentRelativePath === relativePath) {
      renderTabStrip();
    } else {
      await openFile(relativePath);
    }
  }

  async function closeToTheRight(relativePath) {
    const index = openTabs.indexOf(relativePath);
    if (index === -1) return;
    const activeTabRemoved = openTabs.slice(index + 1).includes(currentRelativePath);
    openTabs = openTabs.slice(0, index + 1);

    if (activeTabRemoved) {
      await openFile(relativePath);
    } else {
      renderTabStrip();
    }
  }

  function closeAll() {
    openTabs = [];
    resetOpenFileState();
  }

  async function refreshDocumentedSections() {
    let sections;
    try {
      sections = await window.rapidDocs.findDocumentedNodes(currentRelativePath);
    } catch {
      // The file currently fails to parse (mid-edit, or genuinely broken
      // syntax) -- there's no reliable way to locate documented sections in
      // code that isn't valid JS/TS at all, so "none found" is the honest
      // fallback. Real bug found via manual testing: this call throwing
      // UNCAUGHT previously aborted the rest of this function -- and, since
      // openFile() awaits this before its own final renderFileStatus() call,
      // aborted THAT too, leaving the Problems panel and this sidebar stuck
      // showing whatever the PREVIOUSLY open file had, frozen, until
      // something else (like clicking a Problems row) happened to call
      // renderFileStatus() directly. The real "failed to parse" error still
      // shows correctly regardless, via the separate Problems/Dashboard
      // message pipeline (SyncService's own try/catch) -- this fallback
      // only concerns documented-section lookup, not error reporting.
      sections = [];
    }
    currentDocumentedSections = sections;

    // Same re-validation Problems already does on every recheck (Objective
    // 3.35): if the currently-shown highlight is a documented section, make
    // sure it still exists and refresh its position -- editing or deleting
    // that exact record must not leave a stale green tint on code that may
    // no longer even be there.
    if (activeHighlight && activeHighlight.key.startsWith("doc:")) {
      const stillPresent = sections.find((s) => docSectionKey(s) === activeHighlight.key);
      activeHighlight = stillPresent
        ? { ...activeHighlight, ranges: [{ start: stillPresent.start, end: stillPresent.end }] }
        : null;
    }
    renderDecorations();
    renderDocumentedSectionsList();
  }

  function docSectionKey(section) {
    return "doc:" + section.recordId;
  }

  // Toggling a Documented-sections row is the ONLY way its green highlight
  // appears -- real feedback: it used to be permanent for every documented
  // region in the file at once, which was redundant (this list already
  // shows something is documented) and meant the actual code underneath
  // was never fully visible. Deliberately does NOT re-fetch from the
  // backend (nothing on disk changed) -- just re-renders from the already-
  // cached currentDocumentedSections, same as Problems' own toggle does.
  function toggleDocSectionHighlight(section) {
    const key = docSectionKey(section);
    if (activeHighlight && activeHighlight.key === key) {
      activeHighlight = null;
    } else {
      activeHighlight = { key, severity: "documented", ranges: [{ start: section.start, end: section.end }] };
    }
    renderDecorations();
    renderDocumentedSectionsList();
  }

  function renderDocumentedSectionsList() {
    const sections = currentDocumentedSections;
    const listEl = document.getElementById("documented-sections-list");
    listEl.innerHTML = "";

    if (sections.length === 0) {
      listEl.innerHTML = '<div class="empty">Nothing documented in this file yet.</div>';
      return;
    }

    for (const section of sections.sort((a, b) => a.start - b.start)) {
      const startLine = lineNumberAt(currentFileContent, section.start);
      const endLine = lineNumberAt(currentFileContent, section.end);
      const row = document.createElement("div");
      row.className = "doc-section-row" + (activeHighlight?.key === docSectionKey(section) ? " active-highlight" : "");
      row.innerHTML =
        '<div class="row-header"><span class="lines clickable-doc-section">lines ' + startLine + "-" + endLine + "</span>" +
        '<div class="row-actions"><button class="edit-button">' + ICONS.edit + " Edit</button>" +
        '<button class="delete-button danger">' + ICONS.delete + " Delete</button></div></div>" +
        '<div class="text clickable-doc-section"></div>';
      row.querySelector(".text").textContent = section.docText;
      // Findable from outside this loop (the code-area context menu, in
      // particular) without needing a fresh DOM query keyed some other way.
      row.dataset.recordId = section.recordId;

      // Attached to the lines label and text body specifically -- NOT the
      // whole row -- so it's structurally impossible for a click here to
      // ever land on .row-actions, regardless of how wide the Edit/Delete
      // buttons get. A row-wide listener with an excluded-ancestor check
      // (event.target.closest(".row-actions")) looked equivalent but wasn't:
      // a real click's default target is the row's geometric center, and a
      // short row's center can fall inside a top-positioned action bar no
      // matter which CSS layout method positions it.
      //
      // Each click both jumps to the location (unchanged) AND toggles the
      // green highlight for that exact section -- see toggleDocSectionHighlight.
      row.querySelector(".lines").addEventListener("click", () => {
        selectByOffsets(section.start, section.end);
        toggleDocSectionHighlight(section);
      });
      row.querySelector(".text").addEventListener("click", () => {
        selectByOffsets(section.start, section.end);
        toggleDocSectionHighlight(section);
      });

      row.querySelector(".delete-button").addEventListener("click", (event) => {
        event.stopPropagation();
        deleteSection(section);
      });

      row.querySelector(".edit-button").addEventListener("click", (event) => {
        event.stopPropagation();
        editSectionInline(section, row.querySelector(".text"));
      });

      listEl.appendChild(row);
    }
  }

  async function deleteSection(section) {
    try {
      await window.rapidDocs.deleteRecord(currentRelativePath, section.recordId);
    } catch (err) {
      addActivityEntry("error", friendlyErrorMessage(err));
    }
    await refreshDocumentedSections();
  }

  // Shared by the documented-sections row's own Edit button and the code
  // area's right-click "Edit documentation" -- same inline swap-for-an-input
  // interaction either way, just triggered from two different places.
  function editSectionInline(section, textEl) {
    const input = document.createElement("input");
    input.className = "edit-input";
    input.value = section.docText;
    textEl.replaceWith(input);
    input.focus();

    input.addEventListener("keydown", async (keyEvent) => {
      if (keyEvent.key === "Enter") {
        // Real bug found via manual testing (Objective 3.42): this call
        // throwing uncaught left the input box stuck open forever, with no
        // error and no way out short of reloading. Refreshing either way
        // (success or failure) is what restores normal display.
        try {
          await window.rapidDocs.editDocText(currentRelativePath, section.recordId, input.value);
        } catch (err) {
          addActivityEntry("error", friendlyErrorMessage(err));
        }
        await refreshDocumentedSections();
      } else if (keyEvent.key === "Escape") {
        await refreshDocumentedSections();
      }
    });
    input.addEventListener("blur", () => refreshDocumentedSections());
  }

  // Right-clicking "Edit documentation" on the code itself has no text
  // element of its own to swap in-place -- reuses the SAME interaction on
  // the corresponding row in the documented-sections list instead, scrolled
  // into view first in case it's currently off-screen.
  function editSectionFromContextMenu(section) {
    const row = document.querySelector(`.doc-section-row[data-record-id="${section.recordId}"]`);
    if (!row) return;
    row.scrollIntoView({ block: "nearest" });
    editSectionInline(section, row.querySelector(".text"));
  }

  // Enters "update" mode: pre-fills the doc bar with the drifted record's
  // own existing text (same reasoning as editSectionInline pre-filling on an
  // ordinary edit -- editing forward from what's there is less friction than
  // retyping from scratch, and for a small drift the old wording is often
  // still mostly right), and relabels the button so submitting here reads as
  // visibly different from documenting a fresh, unrelated selection.
  function beginDriftUpdate(staleRecord) {
    pendingDriftUpdate = { oldRecordId: staleRecord.recordId };
    const input = document.getElementById("doc-text-input");
    input.value = staleRecord.docText;
    input.focus();
    document.getElementById("write-doc-button").textContent = "Update Documentation";
  }

  function clearDriftUpdateMode() {
    pendingDriftUpdate = null;
    document.getElementById("write-doc-button").textContent = "Document Selection";
  }

  // A recordId is an internal hash -- meaningless to look at, and left
  // lingering indefinitely was just visual clutter once the actual
  // confirmation (the new row appearing in Documented sections) is already
  // visible. Success messages auto-clear; validation/error messages don't,
  // since those need to stay until the user actually does something about
  // them.
  //
  // severity drives real color (green/red/blue, the same system used
  // everywhere else in the app), not just text -- flat --muted gray for
  // every message here, regardless of whether it was a success, a gentle
  // "select something first" hint, or an actual error, meant nothing ever
  // stood out enough to register as worth reading. Found via real feedback:
  // an actual write error had been genuinely easy to miss.
  // Electron/IPC wraps every error a main-process handler throws in
  // boilerplate like "Error invoking remote method 'docs:writeDoc': Error:
  // ..." -- that's plumbing for developers of rapid-docs, not something a
  // person using the tool should ever see. Stripped here, with a couple of
  // specific known cases rephrased into plain language on top; anything
  // unrecognized still falls back to the (now at least de-wrapped) original
  // text rather than hiding it entirely.
  function friendlyErrorMessage(err) {
    // No IPC-wrapper stripping needed here anymore -- main.ts's safeHandle /
    // preload.ts's invokeOrThrow (Objective 3.29) mean a caught backend
    // error now arrives as a plain local throw with just its real message,
    // never Electron's own "Error invoking remote method 'X': Error: ..."
    // wrapper. Confirmed by real evidence, not left in defensively: this
    // function was tested with the wrapper text still present and it no
    // longer appears.
    if (/already documented as record/.test(err.message)) {
      return "This is already documented. Use the Edit button to change its text.";
    }

    return err.message;
  }

  function setStatus(el, text, severity, autoClearMs) {
    if (el._clearTimeout) {
      clearTimeout(el._clearTimeout);
      el._clearTimeout = null;
    }
    el.textContent = text;
    el.className = severity ? "status-" + severity : "";
    if (autoClearMs) {
      el._clearTimeout = setTimeout(() => {
        el.textContent = "";
        el.className = "";
        el._clearTimeout = null;
      }, autoClearMs);
    }
  }

  document.getElementById("write-doc-button").addEventListener("click", async () => {
    const { start, end } = getSelectionOffsets();
    const docText = document.getElementById("doc-text-input").value;

    if (currentRelativePath === null) {
      addActivityEntry("hint", "Open a file first.");
      return;
    }
    // Every entry from here on is about a specific, already-known file --
    // appended so two entries with otherwise-identical text (e.g.
    // "Documented.") can actually be told apart. Real feedback: Activity
    // entries never recorded which file they were about at all, so
    // documenting a second file looked, from the log alone, like nothing
    // had happened.
    if (start === end) {
      addActivityEntry("hint", `Select some code in the file above first. (${currentRelativePath})`);
      return;
    }
    if (!docText.trim()) {
      addActivityEntry("hint", `Enter some documentation text first. (${currentRelativePath})`);
      return;
    }

    // One-shot: whatever the outcome, this specific pending update is
    // consumed right here, so a later, unrelated "Document Selection"
    // submission can never accidentally be redirected into updating some
    // earlier drifted record it was never actually about.
    const driftUpdate = pendingDriftUpdate;
    clearDriftUpdateMode();

    try {
      if (driftUpdate) {
        await window.rapidDocs.updateDriftedDoc(currentRelativePath, driftUpdate.oldRecordId, start, end, docText);
        addActivityEntry("success", `Updated documentation for changed code. (${currentRelativePath})`);
      } else {
        await window.rapidDocs.writeDoc(currentRelativePath, start, end, docText);
        addActivityEntry("success", `Documented. (${currentRelativePath})`);
      }
      document.getElementById("doc-text-input").value = "";
      await refreshDocumentedSections();
    } catch (err) {
      addActivityEntry("error", `${friendlyErrorMessage(err)} (${currentRelativePath})`);
    }
  });

  // Renders the CURRENT complete set of messages every time -- never
  // appends. Main process is the source of truth for "what's currently
  // wrong, and where"; the renderer's only job is to display whatever
  // snapshot it was just given, so a fixed problem disappears the
  // moment main stops reporting it, instead of lingering forever.
  function renderMessageRows(containerId, messages, emptyText) {
    const listEl = document.getElementById(containerId);
    listEl.innerHTML = "";

    if (messages.length === 0) {
      listEl.innerHTML = '<div class="empty">' + emptyText + "</div>";
      return;
    }

    for (const message of messages) {
      const row = document.createElement("div");
      row.className = "message-row " + message.severity;
      row.innerHTML = '<span class="badge">[' + message.severity + "]</span> ";
      row.appendChild(document.createTextNode(message.text));
      listEl.appendChild(row);
    }
  }

  let latestMessages = [];

  // Problems (repo-truth, live-recomputed) and Activity (a real, persistent
  // log of Document Selection attempts) share one tabbed area and one
  // Clear Selected/Clear All mechanism, but are fundamentally different
  // kinds of data -- see Objective 3.30 in the design notes. Problems can
  // be manually cleared (by explicit user choice, even knowing a genuinely
  // still-true problem will simply reappear the next time this file is
  // actually rechecked); Activity entries are real removals, since nothing
  // ever recomputes them.
  let currentStatusTab = "problems";
  const clearedProblemKeys = new Set();
  const selectedProblemKeys = new Set();
  let activityLog = [];
  let nextActivityId = 1;
  const selectedActivityIds = new Set();

  function problemKey(message) {
    return message.severity + "::" + message.text;
  }

  // Shared by both tabs: a checkbox per row (never a single "x" -- clearing
  // is deliberately batch-oriented, 1 to n at once, not one at a time) plus
  // the same severity-chip look used everywhere else. keyFn extracts
  // whatever identity value belongs in the selection set for that row.
  // deleteAction is optional and Problems-only: when provided, an item with
  // severity "error" and a recordId gets a real delete button alongside the
  // checkbox. Restricted to "error" (fully stale -- no code matches this
  // record at all anymore) deliberately, never "warning" (partially stale --
  // still real, accurate content worth keeping and updating, not deleting).
  // onRowClick is also Problems-only: clicking a row with real ranges is
  // what turns drift highlighting on for exactly that problem -- see
  // toggleHighlight. Attached to the label specifically, not the whole row,
  // so it can never geometrically overlap the checkbox or delete button.
  function renderClearableRows(containerId, items, emptyText, selectedKeys, keyFn, deleteAction, onRowClick) {
    const listEl = document.getElementById(containerId);
    listEl.innerHTML = "";

    if (items.length === 0) {
      listEl.innerHTML = '<div class="empty">' + emptyText + "</div>";
      return;
    }

    for (const item of items) {
      const key = keyFn(item);
      const row = document.createElement("div");
      row.className = "clearable-row " + item.severity;
      if (onRowClick && activeHighlight && activeHighlight.key === key) {
        row.classList.add("active-highlight");
      }

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selectedKeys.has(key);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectedKeys.add(key);
        else selectedKeys.delete(key);
      });

      const label = document.createElement("span");
      label.innerHTML = '<span class="badge">[' + item.severity + "]</span> ";
      label.appendChild(document.createTextNode(item.text));

      if (onRowClick && item.ranges && item.ranges.length > 0) {
        label.classList.add("clickable-problem");
        label.addEventListener("click", () => onRowClick(item, key));
      }

      row.appendChild(checkbox);
      row.appendChild(label);

      if (deleteAction && item.severity === "error" && item.recordId) {
        const deleteButton = document.createElement("button");
        deleteButton.className = "danger delete-record-button";
        deleteButton.innerHTML = ICONS.discard + " Delete";
        deleteButton.addEventListener("click", async (event) => {
          event.stopPropagation();
          await deleteAction(item);
        });
        row.appendChild(deleteButton);
      }

      listEl.appendChild(row);
    }
  }

  // Toggling a Problems row is the ONLY way drift highlighting appears --
  // real feedback: an always-on tint over every problem at once was noise,
  // not help. Clicking the same row again turns it off; clicking a
  // different one replaces whichever was showing (only ever one at a time).
  function toggleHighlight(message, key) {
    if (activeHighlight && activeHighlight.key === key) {
      activeHighlight = null;
    } else {
      activeHighlight = { key, severity: message.severity, ranges: message.ranges };
      const model = editor.getModel();
      if (model && message.ranges.length > 0) {
        editor.revealPositionInCenter(model.getPositionAt(message.ranges[0].start));
      }
    }
    renderDecorations();
    renderFileStatus();
  }

  function renderFileStatus() {
    const forThisFile = latestMessages.filter(
      (m) => m.relativePath === currentRelativePath && !clearedProblemKeys.has(problemKey(m))
    );

    // A live recheck can invalidate the currently-shown highlight two ways:
    // the problem might be gone entirely (fixed, or cleared), or it might
    // still exist but with shifted ranges (something else in the file
    // changed around it) -- either way, re-derive from the CURRENT message
    // rather than trust the stale one still sitting in activeHighlight.
    if (activeHighlight) {
      const stillPresent = forThisFile.find((m) => problemKey(m) === activeHighlight.key);
      activeHighlight = stillPresent ? { ...activeHighlight, ranges: stillPresent.ranges } : null;
      renderDecorations();
    }

    updateTabCount("problems", forThisFile.length);

    renderClearableRows(
      "problems-tab",
      forThisFile,
      "No issues detected in this file.",
      selectedProblemKeys,
      problemKey,
      async (item) => {
        try {
          await window.rapidDocs.deleteRecord(currentRelativePath, item.recordId);
          // deleteRecord's own IPC handler already recomputes and pushes this
          // file's current messages (onLiveMessages below re-renders from
          // that) -- nothing further to do here once the delete resolves.
        } catch (err) {
          addActivityEntry("error", friendlyErrorMessage(err));
        }
      },
      toggleHighlight
    );
  }

  function renderActivityLog() {
    renderClearableRows("activity-tab", activityLog, "No activity yet.", selectedActivityIds, (entry) => entry.id);
  }

  function addActivityEntry(severity, text) {
    activityLog.push({ id: nextActivityId++, severity, text });
    renderActivityLog();
  }

  // Clear Selected/Clear All only ever meant something for Problems/Activity
  // (both built from renderClearableRows' checkboxes) -- Archive already has
  // its own per-row Discard action, and Dashboard is a plain read-only list,
  // so neither has anything for these buttons to act on.
  // Problems/Archive/Dashboard get a count badge on their own tab label,
  // matching the reference style the user pointed to -- Activity
  // deliberately excluded, per their own explicit request. The badge
  // itself (.status-tab-count) is already in the static markup on all
  // three; :empty { display: none } in the CSS is what keeps it invisible
  // whenever count is 0, without needing a separate visibility toggle here.
  function updateTabCount(tabName, count) {
    const badge = document.querySelector(`.status-tab-button[data-status-tab="${tabName}"] .status-tab-count`);
    if (badge) badge.textContent = count > 0 ? String(count) : "";
  }

  function updateClearButtonsVisibility() {
    const applies = currentStatusTab === "problems" || currentStatusTab === "activity";
    document.getElementById("status-clear-selected-button").classList.toggle("hidden", !applies);
    document.getElementById("status-clear-all-button").classList.toggle("hidden", !applies);
  }

  document.querySelectorAll(".status-tab-button").forEach((button) => {
    button.addEventListener("click", () => {
      currentStatusTab = button.dataset.statusTab;
      document.querySelectorAll(".status-tab-button").forEach((b) => b.classList.toggle("active", b === button));
      document.getElementById("problems-tab").classList.toggle("active", currentStatusTab === "problems");
      document.getElementById("activity-tab").classList.toggle("active", currentStatusTab === "activity");
      document.getElementById("archive-tab").classList.toggle("active", currentStatusTab === "archive");
      document.getElementById("dashboard-tab").classList.toggle("active", currentStatusTab === "dashboard");
      updateClearButtonsVisibility();
    });
  });

  document.getElementById("status-clear-selected-button").addEventListener("click", () => {
    if (currentStatusTab === "problems") {
      for (const key of selectedProblemKeys) clearedProblemKeys.add(key);
      selectedProblemKeys.clear();
      renderFileStatus();
    } else {
      activityLog = activityLog.filter((entry) => !selectedActivityIds.has(entry.id));
      selectedActivityIds.clear();
      renderActivityLog();
    }
  });

  document.getElementById("status-clear-all-button").addEventListener("click", () => {
    if (currentStatusTab === "problems") {
      const forThisFile = latestMessages.filter((m) => m.relativePath === currentRelativePath);
      for (const m of forThisFile) clearedProblemKeys.add(problemKey(m));
      selectedProblemKeys.clear();
      renderFileStatus();
    } else {
      activityLog = [];
      selectedActivityIds.clear();
      renderActivityLog();
    }
  });

  async function loadCatchUpMessages() {
    latestMessages = await window.rapidDocs.getCatchUpMessages();
    renderMessageRows("messages-list", latestMessages, "Nothing to report.");
    updateTabCount("dashboard", latestMessages.length);
    renderFileStatus();
  }

  window.rapidDocs.onLiveMessages((messages) => {
    latestMessages = messages;
    renderMessageRows("messages-list", latestMessages, "Nothing to report.");
    updateTabCount("dashboard", latestMessages.length);
    renderFileStatus();

    // A live event always means SOMETHING changed on disk -- a new file, a
    // deleted one, a rename -- not just "this file's messages changed."
    // Without this, LiveWatchService correctly detects a file created
    // outside the app, but the file tree never reflects it until something
    // else happens to reload the whole list (a repo switch, a restart).
    // Found via real testing: creating a file in an external editor while
    // rapid-docs was open never made it appear in the tree.
    loadFileList();

    // The same class of gap, one level over: deleting a documented file from
    // outside the app correctly archives its records on the backend (proven
    // directly -- `.rapid-docs/_archive.json` genuinely gained new entries),
    // but nothing ever re-fetched the Archive tab afterward -- switching tabs
    // only ever toggled CSS visibility, never refetched; refreshArchiveList
    // was previously only called once at bootstrap and after the user's own
    // attach/discard actions, never in response to a live external event.
    // Found via real testing: the Archive tab kept showing "Nothing
    // archived" even after a real archive entry existed on disk.
    refreshArchiveList();
  });

  // The same class of gap as onLiveMessages/loadFileList above, but for the
  // currently OPEN file's actual content: editing it in another editor while
  // it's open here never updated what Monaco displayed, only fixed by
  // clicking away to another file and back. relativePaths (not messages) is
  // the reliable signal here, since a message list can legitimately go to
  // empty on a real content change (the file just became fully clean).
  window.rapidDocs.onFilesChanged(async (relativePaths) => {
    if (currentRelativePath === null || !relativePaths.includes(currentRelativePath)) {
      return;
    }

    // Re-running openFile is exactly what the user's own workaround
    // (click away, click back) already did manually -- automating that,
    // not inventing a new, lighter-weight refresh path. openFile() itself
    // now handles a concurrently deleted/renamed file gracefully (Objective
    // 3.42), so no try/catch needed here anymore.
    await openFile(currentRelativePath);
  });

  let pendingArchiveId = null;

  async function refreshArchiveList() {
    let records;
    try {
      records = await window.rapidDocs.listArchive();
    } catch (err) {
      addActivityEntry("error", friendlyErrorMessage(err));
      records = [];
    }
    updateTabCount("archive", records.length);
    const listEl = document.getElementById("archive-list");
    listEl.innerHTML = "";

    if (records.length === 0) {
      listEl.innerHTML = '<div class="empty">Nothing archived.</div>';
      return;
    }

    for (const record of records) {
      const row = document.createElement("div");
      row.className = "archive-row" + (record.id === pendingArchiveId ? " pending" : "");
      row.innerHTML =
        '<div class="row-header"><span class="origin clickable-archive"></span>' +
        '<button class="discard-button danger">' + ICONS.discard + " Discard</button></div>" +
        '<div class="text clickable-archive"></div>';
      row.querySelector(".origin").textContent = "from " + record.originalFileId;
      row.querySelector(".text").textContent = record.docText;

      // Same reasoning as the documented-sections row fix: attached to the
      // origin label and text body specifically, not the whole row, so a
      // click here can never geometrically land on the discard button.
      row.querySelector(".origin").addEventListener("click", () => {
        pendingArchiveId = record.id;
        refreshArchiveList();
      });
      row.querySelector(".text").addEventListener("click", () => {
        pendingArchiveId = record.id;
        refreshArchiveList();
      });

      row.querySelector(".discard-button").addEventListener("click", async (event) => {
        event.stopPropagation();
        try {
          await window.rapidDocs.discardArchivedRecord(record.id);
          if (pendingArchiveId === record.id) pendingArchiveId = null;
        } catch (err) {
          addActivityEntry("error", friendlyErrorMessage(err));
        }
        await refreshArchiveList();
      });

      listEl.appendChild(row);
    }
  }

  document.getElementById("attach-archive-button").addEventListener("click", async () => {
    const statusEl = document.getElementById("archive-attach-status");
    const { start, end } = getSelectionOffsets();

    if (pendingArchiveId === null) {
      setStatus(statusEl, "Select an archived item first.", "hint");
      return;
    }
    if (currentRelativePath === null) {
      setStatus(statusEl, "Open a file first.", "hint");
      return;
    }
    if (start === end) {
      setStatus(statusEl, "Select some code in the file above first.", "hint");
      return;
    }

    try {
      await window.rapidDocs.attachArchivedRecord(pendingArchiveId, currentRelativePath, start, end);
      setStatus(statusEl, "Attached.", "success");
      pendingArchiveId = null;
      await refreshArchiveList();
      await refreshDocumentedSections();
    } catch (err) {
      setStatus(statusEl, friendlyErrorMessage(err), "error");
    }
  });

  // Shows the in-app empty state instead of the normal 3-view UI when no
  // repo is active -- the ONLY way the OS folder-picker ever appears is via
  // a button inside one of these two states, never automatically.
  //
  // repo-actions (theme toggle, switch repository, close repository) is
  // gated the same way -- "Switch repository" duplicates the empty state's
  // own "Open a repository" button with nothing open yet, and "Close
  // repository" has nothing to close, so both were real dead buttons on
  // that screen, not just visual clutter. Theme toggle is swept in with
  // them rather than special-cased, since it's the same top-bar cluster and
  // there's nothing about it that needs to work before a repo is open.
  function updateRepoVisibility(repoPath) {
    document.getElementById("empty-state").classList.toggle("hidden", repoPath !== null);
    document.getElementById("app-body").classList.toggle("hidden", repoPath === null);
    document.getElementById("repo-actions").classList.toggle("hidden", repoPath === null);

    // Only fetched when the empty state is actually about to be shown --
    // every path that leads there (first launch with nothing remembered,
    // closing a repo) already goes through here via loadActiveRepoPath, so
    // this is the one place that guarantees freshness without also firing
    // a pointless IPC call every time a repo is simply opened instead.
    //
    // Collapsed back to the initial short list every time the empty state
    // is freshly entered -- "Show More" is a per-visit reveal, not a
    // sticky preference, matching the reference picker this is modeled on.
    if (repoPath === null) {
      workspacesExpanded = false;
      renderRecentWorkspaces();
    }
  }

  // A path's own last segment as a display name -- no Node "path" module in
  // the renderer's sandboxed context, and paths seen so far (repo paths,
  // file relativePaths) can appear with either separator, so both are
  // handled rather than assuming one. Shared by the workspaces list (repo
  // folder names) and the tab strip (file names).
  function lastPathSegment(pathValue) {
    const segments = pathValue.split(/[\\/]/).filter((segment) => segment.length > 0);
    return segments[segments.length - 1] ?? pathValue;
  }

  const INITIAL_VISIBLE_WORKSPACES = 4;
  let workspacesExpanded = false;

  async function renderRecentWorkspaces() {
    const container = document.getElementById("recent-workspaces");
    const listEl = document.getElementById("recent-workspaces-list");

    let repoPaths;
    try {
      repoPaths = await window.rapidDocs.listRecentRepos();
    } catch (err) {
      addActivityEntry("error", friendlyErrorMessage(err));
      repoPaths = [];
    }

    container.classList.toggle("hidden", repoPaths.length === 0);
    listEl.innerHTML = "";

    const visiblePaths = workspacesExpanded ? repoPaths : repoPaths.slice(0, INITIAL_VISIBLE_WORKSPACES);

    for (const repoPath of visiblePaths) {
      const row = document.createElement("div");
      row.className = "workspace-row";
      row.innerHTML =
        '<div class="workspace-name"><span class="workspace-spinner">' +
        ICONS.spinner +
        '</span><span class="workspace-name-text"></span></div>' +
        '<div class="workspace-path"></div>';
      row.querySelector(".workspace-name-text").textContent = lastPathSegment(repoPath);
      row.querySelector(".workspace-path").textContent = repoPath;

      row.addEventListener("click", async () => {
        if (repoOpenInProgress) return;
        repoOpenInProgress = true;
        setRepoOpeningLoadingState(true);
        row.classList.add("opening");

        try {
          await window.rapidDocs.openRepoPath(repoPath);
        } catch (err) {
          addActivityEntry("error", friendlyErrorMessage(err));
          return;
        } finally {
          repoOpenInProgress = false;
          setRepoOpeningLoadingState(false);
          row.classList.remove("opening");
        }
        resetOpenFileState();
        await loadActiveRepoPath();
        await loadFileList();
        await loadCatchUpMessages();
        await refreshArchiveList();
      });

      listEl.appendChild(row);
    }

    if (!workspacesExpanded && repoPaths.length > INITIAL_VISIBLE_WORKSPACES) {
      const showMore = document.createElement("div");
      showMore.className = "workspace-show-more";
      showMore.textContent = "Show More...";
      showMore.addEventListener("click", () => {
        workspacesExpanded = true;
        renderRecentWorkspaces();
      });
      listEl.appendChild(showMore);
    }
  }

  async function loadActiveRepoPath() {
    const repoPath = await window.rapidDocs.getActiveRepoPath();
    document.getElementById("active-repo-path").textContent = repoPath ?? "No repository selected.";
    updateRepoVisibility(repoPath);

    // Monaco was created once, unconditionally, regardless of whether a repo
    // was active yet -- if the empty state was showing at that moment,
    // #app-body (and Monaco's container inside it) was 0x0. Revealing it now
    // doesn't guarantee automaticLayout's polling catches the change on its
    // own.
    if (repoPath !== null && editorInstance) {
      editorInstance.layout();
    }
  }

  // Shared by pickRepo (switching to a different repo) and closeRepo
  // (going back to no repo at all) -- neither the currently open file, its
  // documented sections, nor any pending archive selection still applies
  // once the active repo is about to change or disappear.
  function resetOpenFileState() {
    currentRelativePath = null;
    currentFileContent = "";
    currentDocumentedSections = [];
    activeHighlight = null;
    openTabs = [];
    renderTabStrip();
    // A different repo's folder structure is unrelated -- a stale
    // collapsed path only matters in the unlikely case another repo
    // happens to share the exact same nested path, but even then it'd be
    // wrong to inherit collapse state from a completely different project.
    collapsedFolderPaths.clear();
    if (currentModel) {
      currentModel.dispose();
      currentModel = null;
    }
    editor.setModel(monaco.editor.createModel("", "plaintext"));
    decorationIds = [];
    document.getElementById("current-file").textContent = "No file selected";
    document.getElementById("documented-sections-list").innerHTML = "";
    clearedProblemKeys.clear();
    selectedProblemKeys.clear();
    renderFileStatus();
    // No file selected anymore -- hides #editor-area and lets the panel
    // expand into that space (unless manually collapsed, which this
    // deliberately leaves untouched either way).
    updatePanelLayout();
    // A repo switch is a bigger context change than a file switch -- the
    // Activity log (a record of THIS repo's Document Selection attempts)
    // no longer applies either, unlike a plain file switch which
    // deliberately leaves it alone.
    activityLog = [];
    selectedActivityIds.clear();
    renderActivityLog();
    pendingArchiveId = null;
  }

  // Shared by "Open a repository" (empty state) and "Switch repository"
  // (top bar) -- picking a repo is exactly the same operation either way,
  // just from two different starting states.
  // A heavy real-world repo (a Python virtualenv sitting inside it, say) can
  // leave the main process synchronously busy -- git scanning thousands of
  // files -- for long enough that Windows itself reports the window as "Not
  // Responding," confirmed via real manual testing. With zero feedback,
  // there's no way to tell a slow-but-working open from a broken one, and a
  // real risk of clicking again (or clicking something else) while it's
  // still in flight. repoOpenInProgress guards against exactly that: every
  // entry point that can open a repo checks it first and refuses to start a
  // second attempt while one's already running.
  let repoOpenInProgress = false;

  function setRepoOpeningLoadingState(isLoading) {
    const openButton = document.getElementById("open-repo-button");
    openButton.disabled = isLoading;
    openButton.innerHTML = isLoading ? ICONS.spinner + " Opening" : "Open a repository";
    // The dropdown menu now covers Switch/Close repository (among other
    // things) -- disabling the one trigger button covers both, the same
    // way disabling it used to cover two separate buttons.
    document.getElementById("top-bar-menu-button").disabled = isLoading;
    document.getElementById("recent-workspaces-list").classList.toggle("disabled", isLoading);
  }

  async function pickRepo(statusEl) {
    if (repoOpenInProgress) return;
    repoOpenInProgress = true;
    setRepoOpeningLoadingState(true);
    if (statusEl) setStatus(statusEl, "Opening repository...", "hint");

    try {
      // workspace:switch throws only for failures other than "not a git
      // repo" now (that case retries internally, via a native error box) --
      // caught here as a general safety net, not because this specific path
      // is expected to fail.
      let result;
      try {
        result = await window.rapidDocs.switchRepo();
      } catch (err) {
        if (statusEl) setStatus(statusEl, friendlyErrorMessage(err), "error");
        return;
      }
      if (!result.switched) {
        if (statusEl) setStatus(statusEl, "", null);
        return;
      }

      resetOpenFileState();
      await loadActiveRepoPath();
      await loadFileList();
      await loadCatchUpMessages();
      await refreshArchiveList();
      if (statusEl) setStatus(statusEl, "", null);
    } finally {
      repoOpenInProgress = false;
      setRepoOpeningLoadingState(false);
    }
  }

  // Matches "Close Folder" in editors like VSCode: returns to the same
  // empty state as before a repo was ever opened, in this same window.
  async function closeRepo() {
    // The button itself is already disabled while a repo-open is in
    // flight (setRepoOpeningLoadingState), but the Ctrl+Shift+W shortcut
    // bypasses that entirely -- guarded here too, at the source, so
    // closing can never race against activateRepo() still running for a
    // switch that's already underway.
    if (repoOpenInProgress) return;

    try {
      await window.rapidDocs.closeRepo();
    } catch (err) {
      // No dedicated status element for this action -- Activity is the
      // closest existing general-purpose log. Real bug found via manual
      // testing (Objective 3.42): this call throwing uncaught made "Close
      // repository" silently do nothing at all, with zero indication why.
      addActivityEntry("error", friendlyErrorMessage(err));
      return;
    }
    resetOpenFileState();
    await loadActiveRepoPath(); // repoPath is now null -> shows the empty state
  }

  // Previously passed null here -- no loading/error feedback ever reached
  // the empty state's own "Open a repository" button at all, exactly the
  // entry point most likely to be waiting on a slow, heavy repo. Same
  // shared #switch-repo-status element either way (it lives outside
  // #repo-actions, so it's never hidden by the empty state itself).
  document.getElementById("open-repo-button").addEventListener("click", () => {
    pickRepo(document.getElementById("switch-repo-status"));
  });

  // Theme toggle: swaps Monaco's own theme AND the CSS custom-property
  // set (via data-theme on <html>) together, so the editor and the
  // surrounding chrome never fall out of sync with each other.
  // Persisted in localStorage -- purely a per-machine UI preference,
  // not repo data, so it doesn't belong in WorkspaceService's
  // cross-session repo state. No longer updates a persistent button's own
  // label/icon (there isn't one anymore) -- the top-bar menu rebuilds its
  // item list fresh every time it opens instead, the same way the
  // right-click context menu already does.
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    monaco.editor.setTheme(theme === "dark" ? "rapid-docs-dark" : "rapid-docs-light");
    localStorage.setItem("rapid-docs-theme", theme);
  }

  // Four actions previously spread across three separate top-bar buttons
  // (plus the panel's own now-hidden-when-collapsed close button) collapsed
  // into one menu -- real gap found via manual testing: once the panel is
  // collapsed, its own close/open affordance is hidden right along with it,
  // leaving Ctrl+Shift+I as the only way back with zero visible hint it
  // exists at all. Reuses the exact same showContextMenu/hideContextMenu
  // infrastructure already built for Monaco's right-click menu -- rebuilt
  // fresh every time it opens (so "Dark mode" vs "Light mode" always
  // reflects whatever's actually current), not a persistent, separately
  //-maintained button per action.
  function buildTopBarMenuItems() {
    const currentTheme = document.documentElement.getAttribute("data-theme") || "light";
    return [
      {
        label: currentTheme === "dark" ? "Light mode" : "Dark mode",
        shortcut: "Ctrl+Shift+T",
        onClick: () => applyTheme(currentTheme === "dark" ? "light" : "dark"),
      },
      {
        label: "Switch repository",
        shortcut: "Ctrl+Shift+O",
        onClick: () => pickRepo(document.getElementById("switch-repo-status")),
      },
      { label: "Close repository", shortcut: "Ctrl+Shift+W", onClick: () => closeRepo() },
      { label: "Open panel", shortcut: "Ctrl+Shift+I", onClick: () => setPanelCollapsed(false) },
    ];
  }

  document.getElementById("top-bar-menu-button").addEventListener("click", (event) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    showContextMenu(rect.left, rect.bottom, buildTopBarMenuItems());
  });

  applyTheme(localStorage.getItem("rapid-docs-theme") || "light");

  // Panel redesign (rapid.txt future-adds-on #2): the panel (Problems/
  // Activity/Archive/Dashboard) sits BELOW the editor now, not above; the
  // editor itself only renders when a file is actually selected (letting
  // the panel expand into that space otherwise); the panel is collapsible
  // like VSCode's own terminal (Ctrl+Shift+I), and resizable via a real
  // drag handle with min/max limits, not just an internal scrollbar. Both
  // the collapsed state and the chosen height persist across restarts, the
  // same as the theme preference -- a per-machine UI choice, not repo data.
  const PANEL_HEIGHT_KEY = "rapid-docs-panel-height";
  const PANEL_COLLAPSED_KEY = "rapid-docs-panel-collapsed";
  const DEFAULT_PANEL_HEIGHT = 180;
  const MIN_PANEL_HEIGHT = 100;
  const MIN_EDITOR_HEIGHT = 150;

  let panelCollapsed = localStorage.getItem(PANEL_COLLAPSED_KEY) === "true";
  let panelHeight = Number(localStorage.getItem(PANEL_HEIGHT_KEY)) || DEFAULT_PANEL_HEIGHT;

  // Reconciles the two independent things that decide this layout: whether
  // a file is currently open (editor-area) and whether the user has
  // manually collapsed the panel (Ctrl+Shift+I). Deliberately no special-
  // case interaction between them -- if BOTH are true (no file open AND the
  // panel is collapsed), both elements simply end up hidden and
  // #content-pane shows plain empty space beneath the header, which is the
  // right behavior: respecting an explicit collapse rather than silently
  // overriding it just because there's nothing else to show.
  function updatePanelLayout() {
    const hasFile = currentRelativePath !== null;
    const editorAreaEl = document.getElementById("editor-area");
    const panelEl = document.getElementById("status-panel");
    const handleEl = document.getElementById("panel-resize-handle");

    editorAreaEl.classList.toggle("hidden", !hasFile);
    panelEl.classList.toggle("hidden", panelCollapsed);
    handleEl.classList.toggle("hidden", panelCollapsed || !hasFile);

    if (panelCollapsed) {
      panelEl.classList.remove("expanded");
    } else if (!hasFile) {
      panelEl.classList.add("expanded");
      panelEl.style.height = "";
    } else {
      panelEl.classList.remove("expanded");
      panelEl.style.height = panelHeight + "px";
    }

    if (editorInstance) editorInstance.layout();
  }

  function setPanelCollapsed(collapsed) {
    panelCollapsed = collapsed;
    localStorage.setItem(PANEL_COLLAPSED_KEY, String(collapsed));
    updatePanelLayout();
  }

  document.addEventListener("keydown", (event) => {
    // event.code, not event.key -- layout/case independent (Shift+I
    // produces different .key values across keyboard layouts, .code names
    // the physical key regardless). preventDefault matters for all four:
    // this whole Ctrl+Shift+<letter> family lives in Electron's default
    // View/Developer menu (DevTools toggle among them), but confirmed via
    // main.ts that Menu.setApplicationMenu(null) already removed every
    // accelerator that would normally be bound to it -- none of these were
    // otherwise claimed by anything.
    //
    // Ctrl+Shift+I is deliberately asymmetric, not a toggle -- it only ever
    // OPENS the panel (a no-op if already open); closing is the explicit X
    // button on the panel itself, matching VSCode's own terminal (the
    // keyboard shortcut and the close button are two different actions
    // there too, not two ways to trigger the same toggle). The other three
    // mirror whatever the corresponding top-bar menu item currently does,
    // by calling the exact same functions the menu's own onClick handlers
    // call -- never a second, separately-maintained code path.
    // Real bug found via manual testing: triggering any of these while the
    // top-bar dropdown menu was already open (opened by mouse, then closed
    // by keyboard) left it visibly stuck open over whatever came next --
    // the menu only ever closes itself on a click, a scroll, Escape, or one
    // of its OWN item clicks, none of which a keyboard shortcut is. Closing
    // it here too, whenever one of these four actually fires, keeps it
    // consistent with how a click anywhere already dismisses it regardless
    // of what else that click was doing.
    if (event.ctrlKey && event.shiftKey && event.code === "KeyI") {
      event.preventDefault();
      hideContextMenu();
      setPanelCollapsed(false);
    } else if (event.ctrlKey && event.shiftKey && event.code === "KeyT") {
      event.preventDefault();
      hideContextMenu();
      const current = document.documentElement.getAttribute("data-theme") || "light";
      applyTheme(current === "dark" ? "light" : "dark");
    } else if (event.ctrlKey && event.shiftKey && event.code === "KeyO") {
      event.preventDefault();
      hideContextMenu();
      pickRepo(document.getElementById("switch-repo-status"));
    } else if (event.ctrlKey && event.shiftKey && event.code === "KeyW") {
      event.preventDefault();
      hideContextMenu();
      closeRepo();
    }
  });

  document.getElementById("panel-close-button").addEventListener("click", () => setPanelCollapsed(true));

  // Tracked via document-level mousemove/mouseup, not just on the handle
  // itself -- a fast drag that momentarily leaves the handle's own thin
  // 6px strip would otherwise silently drop the resize mid-drag.
  (function setUpPanelResize() {
    const handleEl = document.getElementById("panel-resize-handle");
    let dragging = false;

    handleEl.addEventListener("mousedown", (event) => {
      dragging = true;
      handleEl.classList.add("dragging");
      event.preventDefault();
    });

    document.addEventListener("mousemove", (event) => {
      if (!dragging) return;

      const paneRect = document.getElementById("content-pane").getBoundingClientRect();
      const handleRect = handleEl.getBoundingClientRect();

      // Distance from the bottom of the content pane up to the cursor is
      // exactly the new panel height -- the handle and editor-area share
      // whatever's left via flex, so nothing else needs computing directly.
      const proposedHeight = paneRect.bottom - event.clientY;
      const maxPanelHeight = Math.max(MIN_PANEL_HEIGHT, paneRect.height - handleRect.height - MIN_EDITOR_HEIGHT);
      panelHeight = Math.min(Math.max(proposedHeight, MIN_PANEL_HEIGHT), maxPanelHeight);

      document.getElementById("status-panel").style.height = panelHeight + "px";
      if (editorInstance) editorInstance.layout();
    });

    document.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      handleEl.classList.remove("dragging");
      localStorage.setItem(PANEL_HEIGHT_KEY, String(panelHeight));
    });
  })();

  // Same shape as the panel resizer above, just the other axis -- a
  // draggable divider between the file tree and the editor, with real
  // min/max limits, so a long filename isn't stuck truncated by a fixed
  // 220px column. MIN_CONTENT_PANE_WIDTH also has to account for
  // #documented-sections' own fixed width, not just the handle's -- three
  // fixed-or-JS-driven columns share #app-body, not two.
  const FILE_LIST_WIDTH_KEY = "rapid-docs-file-list-width";
  const DEFAULT_FILE_LIST_WIDTH = 220;
  const MIN_FILE_LIST_WIDTH = 120;
  const MIN_CONTENT_PANE_WIDTH = 300;

  let fileListWidth = Number(localStorage.getItem(FILE_LIST_WIDTH_KEY)) || DEFAULT_FILE_LIST_WIDTH;
  document.getElementById("file-list").style.width = fileListWidth + "px";

  (function setUpFileListResize() {
    const handleEl = document.getElementById("file-list-resize-handle");
    let dragging = false;

    handleEl.addEventListener("mousedown", (event) => {
      dragging = true;
      handleEl.classList.add("dragging");
      event.preventDefault();
    });

    document.addEventListener("mousemove", (event) => {
      if (!dragging) return;

      const appBodyRect = document.getElementById("app-body").getBoundingClientRect();
      const handleRect = handleEl.getBoundingClientRect();
      const documentedSectionsRect = document.getElementById("documented-sections").getBoundingClientRect();

      // Distance from the left of #app-body to the cursor is exactly the
      // new file-list width -- the handle and content-pane share whatever's
      // left via flex, so nothing else needs computing directly.
      const proposedWidth = event.clientX - appBodyRect.left;
      const maxFileListWidth = Math.max(
        MIN_FILE_LIST_WIDTH,
        appBodyRect.width - handleRect.width - documentedSectionsRect.width - MIN_CONTENT_PANE_WIDTH
      );
      fileListWidth = Math.min(Math.max(proposedWidth, MIN_FILE_LIST_WIDTH), maxFileListWidth);

      document.getElementById("file-list").style.width = fileListWidth + "px";
      if (editorInstance) editorInstance.layout();
    });

    document.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      handleEl.classList.remove("dragging");
      localStorage.setItem(FILE_LIST_WIDTH_KEY, String(fileListWidth));
    });
  })();

  updatePanelLayout();

  loadActiveRepoPath();
  loadFileList();
  loadCatchUpMessages();
  refreshArchiveList();
  renderActivityLog();
}
