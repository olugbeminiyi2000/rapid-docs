const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

// Real packaging bug this fixes (2026-08-16): bootstrap.ts used to load the
// shared backend via a dynamic import() of the ROOT project's separately
// compiled dist/*.js, and vscode.window's own "vscode" module aside, nothing
// about the extension's actual runtime dependencies (@nestjs/core, the
// backend services themselves) were ever included in vscode-extension's own
// package. That only ever worked in THIS dev repo, where vscode-extension/
// happens to sit next to the root project's own dist/ -- installed as a real
// .vsix on someone else's machine, none of that exists, and activation would
// fail immediately. Bundling everything (backend included, now imported
// directly from ../../../src/*.ts, not dist/) into one self-contained
// dist/extension.js is the standard fix for VSCode extensions in general,
// not just this problem.
//
// NestJS-specific gotcha, found via a real failed build, not predicted in
// advance: @nestjs/core internally does guarded require() calls for several
// optional peer packages it supports but this project never installs
// (microservices/websockets support, class-validator, etc.). esbuild's
// bundler tries to resolve every require() it sees at build time and fails
// hard if one of these isn't actually in node_modules -- marking them
// external (never bundled, left as a real require() call that NestJS's own
// try/catch around it already handles gracefully at runtime by design) is
// the standard, documented way to bundle a NestJS app.
const nestOptionalPeerDeps = [
  "@nestjs/microservices",
  "@nestjs/websockets",
  "@nestjs/websockets/socket-module",
  "@nestjs/platform-express",
  "@nestjs/platform-fastify",
  "cache-manager",
  "class-validator",
  "class-transformer",
  "@fastify/static",
];

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    outfile: "dist/extension.js",
    // "vscode" is provided by the extension host at runtime, never bundled --
    // the one external every VSCode extension needs, regardless of anything
    // else here.
    external: ["vscode", ...nestOptionalPeerDeps],
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    logLevel: "info",
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
