import * as vscode from "vscode";
import { getNonce } from "./getNonce";

// Reused by every rapid-docs Webview (this foundation one, and 7.2's
// Documented Sections / 7.3's compose / 7.5's Archive / 7.6's Activity as
// they get built) so theming and CSP setup exist in exactly one place, not
// hand-rolled per view the way electron/renderer.js's own styles.css was
// one giant, separately-maintained file. Every color comes from VSCode's own
// CSS custom properties (--vscode-*), never a hardcoded hex value -- the
// same technique real, polished extension panels (e.g. Claude Code's own
// sidebar) use, so this automatically matches whatever theme the user has,
// light/dark/high-contrast, with zero theme-tracking code of our own.
const BASE_STYLE = `
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 8px;
    margin: 0;
  }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 2px;
    padding: 4px 10px;
    cursor: pointer;
    font-family: inherit;
    font-size: inherit;
  }
  button:hover {
    background: var(--vscode-button-hoverBackground);
  }
  button:focus {
    outline: 1px solid var(--vscode-focusBorder);
  }
  input, textarea {
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    padding: 4px 6px;
    font-family: inherit;
    font-size: inherit;
  }
  a { color: var(--vscode-textLink-foreground); }
  .muted { color: var(--vscode-descriptionForeground); }
`;

export interface WebviewShellOptions {
  webview: vscode.Webview;
  title: string;
  bodyHtml: string;
  scriptJs: string;
  extraStyle?: string;
}

export function renderWebviewShell(options: WebviewShellOptions): string {
  const nonce = getNonce();
  const csp = [
    "default-src 'none'",
    `style-src ${options.webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${options.title}</title>
<style>${BASE_STYLE}${options.extraStyle ?? ""}</style>
</head>
<body>
${options.bodyHtml}
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
${options.scriptJs}
</script>
</body>
</html>`;
}
