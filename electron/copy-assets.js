// Static assets for the renderer that tsc doesn't touch (it only compiles
// main.ts/preload.ts) -- copied here explicitly so build:electron can't
// silently ship a stale index.html/styles.css/renderer.js again, the same
// class of bug that bit this project once before (see design notes,
// Objective 3.13 §67).
const { copyFileSync, cpSync } = require("fs");

copyFileSync("electron/index.html", "electron/dist/index.html");
copyFileSync("electron/styles.css", "electron/dist/styles.css");
copyFileSync("electron/renderer.js", "electron/dist/renderer.js");
cpSync("node_modules/monaco-editor/min/vs", "electron/dist/vs", { recursive: true });
