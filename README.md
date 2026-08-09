<p align="center">
  <img src="electron/icon-256.png" alt="rapid-docs icon" width="96" />
</p>

# rapid-docs

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat&logo=javascript&logoColor=black)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=nodedotjs&logoColor=white)
![NestJS](https://img.shields.io/badge/NestJS-E0234E?style=flat&logo=nestjs&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-47848F?style=flat&logo=electron&logoColor=white)
![Monaco Editor](https://img.shields.io/badge/Monaco%20Editor-007ACC?style=flat&logo=visualstudiocode&logoColor=white)
![Jest](https://img.shields.io/badge/Jest-C21325?style=flat&logo=jest&logoColor=white)
![Git](https://img.shields.io/badge/Git-F05032?style=flat&logo=git&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat)

A desktop tool that keeps hand-written documentation attached to code *structure*, not to line numbers. A comment/note you write for a function stays correct even after the function moves, gets reformatted, or has code added around it, and gets flagged the moment the code it actually describes changes underneath it.

> Status: **v0.1.0**, actively developed, Windows-only for now. Built as a personal project to explore AST-based tooling end to end; expect rough edges, and issues are welcome.

## Screenshots

No repository open yet, picking from recently used workspaces:

![No repository open, with a list of recent workspaces to pick from](assets/screenshots/open_repository_page.png)

Opening a repository, with per-workspace loading feedback:

![A workspace row showing an in-progress loading spinner while its repository opens](assets/screenshots/loading_git_repo.png)

A real repository open, with multiple tabs, the Problems panel, and the top-bar menu:

![The editor with several tabs open, the Problems panel showing undocumented-code messages, and the top-bar menu listing keyboard shortcuts](assets/screenshots/editor_screen_part_1.png)

The Documented sections panel, with edit/delete/copy on a selected node:

![The Documented sections panel listing several documented code ranges, with an edit/delete/copy context menu open on one of them](assets/screenshots/editor_screen_part_2.png)

Right-clicking a tab for VS Code-style close options:

![A tab's right-click menu showing Close, Close Others, Close to the Right, and Close All](assets/screenshots/editor_screen_part_3.png)

## The problem this solves

When I'm solving something non-trivial, I like to fully explain my reasoning: why I picked one approach over another, what a piece of state is actually tracking, what would break if it were done differently. Writing that directly in the file as a comment forces a bad tradeoff: write enough for it to actually be useful, and the file gets cluttered; keep it short enough to stay clean, and the reasoning gets lost.

The natural fix is to move that documentation outside the file entirely. But an ordinary comment gets its connection to the right code for free, it's physically sitting right above it in the same text. Move the note somewhere else, and that connection has to be built deliberately, since nothing about the note's position tells you what it's about anymore.

rapid-docs' answer is to anchor a note to a specific **AST node** (a function, a block, an expression) instead of a position. Because the link is structural rather than positional, whitespace changes, reordering, and reformatting don't break it, but an actual change to the documented code's shape does, and gets surfaced as drift.

## How it works

1. Open a local git repository in the app.
2. Select a piece of code in the editor and write a short description for it.
3. rapid-docs snaps your selection to the AST nodes between that highlighted section and stores a structural fingerprint of it: not the raw text, and not a line number.
4. From then on, every commit and every live file save is checked against that fingerprint. If the documented node's structure has genuinely changed, it's reported as drift; if the code around it changed but the node itself didn't, nothing fires.

Documentation is stored as plain JSON, one file per source file, inside a `.rapid-docs/` folder next to the code it describes: versionable in the same repo, readable without the app, and requiring no external database.

## Architecture

- **Backend**: a NestJS application (dependency-injected services, not an HTTP server) providing:
  - AST parsing and structural fingerprinting (`@babel/parser`/`@babel/types`)
  - Git integration: commit-based diffing for drift checks on every commit, and live file-watching (`chokidar`, gitignore-aware) for changes that haven't been committed yet
  - Documentation storage and drift/message reporting
- **Desktop shell**: Electron, with a Monaco-based editor for viewing and selecting code (read-only with respect to the code itself; rapid-docs never edits or saves the files it documents), tabs for multiple open files, and panels for Problems, Documented sections, Archive, and a live Dashboard.
- The Electron main process talks to the NestJS backend via `NestFactory.createApplicationContext`, in-process, with no separate server to run.

## Getting started

Requires Node.js and npm.

```bash
npm install
npm run start:electron
```

This builds both the backend and the Electron shell and launches the app. Individual steps, if you need them:

```bash
npm run build        # NestJS backend -> dist/
npm run build:electron  # Electron main/preload -> electron/dist/, plus static assets
npm test              # full Jest suite
```

## License

MIT. See [LICENSE](LICENSE).
