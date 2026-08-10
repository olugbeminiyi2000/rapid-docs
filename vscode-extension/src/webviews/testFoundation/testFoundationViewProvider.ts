import * as vscode from "vscode";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { renderWebviewShell } from "../shared/webviewShell";

// Section 7.1's actual proof-of-concept: a real WebviewView, themed purely
// from VSCode's own CSS variables (no hardcoded colors), with real two-way
// message passing verified end to end -- a button click inside the webview
// reaches the extension host (proof file written, same discipline as every
// backend section), and a reply reaches back into the webview's own DOM.
// Every later Webview in this section (Documented Sections, Compose,
// Archive, Activity) reuses renderWebviewShell rather than repeating this
// HTML/CSP setup.
export class TestFoundationViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "rapidDocsTestFoundation";

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = { enableScripts: true };

    webviewView.webview.html = renderWebviewShell({
      webview: webviewView.webview,
      title: "rapid-docs webview foundation test",
      bodyHtml: `
        <p>Section 7.1: Webview infrastructure proof.</p>
        <button id="ping-button">Send test message</button>
        <p id="status" class="muted">(nothing sent yet)</p>
      `,
      scriptJs: `
        const statusEl = document.getElementById('status');
        document.getElementById('ping-button').addEventListener('click', () => {
          statusEl.textContent = 'sent, waiting for reply...';
          vscode.postMessage({ type: 'ping', sentAt: Date.now() });
        });
        window.addEventListener('message', (event) => {
          const message = event.data;
          if (message.type === 'pong') {
            statusEl.textContent = 'real reply received at ' + message.repliedAt;
          }
        });
      `,
    });

    webviewView.webview.onDidReceiveMessage((message: { type: string; sentAt: number }) => {
      if (message.type !== "ping") return;

      const repliedAt = new Date().toISOString();
      writeFileSync(
        join(tmpdir(), "rapid-docs-webview-foundation-proof.txt"),
        `ping received at ${repliedAt}\nsentAt (from webview): ${new Date(message.sentAt).toISOString()}\n`
      );

      void webviewView.webview.postMessage({ type: "pong", repliedAt });
    });
  }
}
