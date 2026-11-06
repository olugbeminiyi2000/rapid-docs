const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");

// Same NestJS-specific gotcha vscode-extension/esbuild.js already found and
// documented: @nestjs/core internally does guarded require() calls for
// several optional peer packages this project never installs
// (microservices/websockets support, class-validator, etc.), each wrapped
// in NestJS's own try/catch so missing them at runtime is fine by design --
// but esbuild's bundler tries to resolve every require() it sees at BUILD
// time and fails hard if one isn't actually in node_modules. Marking them
// external (never bundled, left as a real require() call) is the standard,
// documented way to bundle a NestJS app.
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
    entryPoints: ["src/index.ts"],
    bundle: true,
    // CJS, not ESM -- same choice vscode-extension already made and proved
    // out: esbuild bridges the root project's own ESM dist/*.js output
    // (package.json there has "type": "module") into a single CJS bundle
    // just fine via its normal interop, which sidesteps NestJS's internal
    // require() calls ever having to survive an ESM bundle at all.
    format: "cjs",
    platform: "node",
    target: "node18",
    outfile: "dist/index.js",
    external: nestOptionalPeerDeps,
    // Makes the published bin directly executable (`npx rapid-docs-mcp-server`
    // invokes this file through the OS's own shebang resolution, same as any
    // other npm CLI package) -- esbuild doesn't add one on its own.
    banner: { js: "#!/usr/bin/env node" },
    sourcemap: true,
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
