// A Content-Security-Policy nonce, required to let our own inline <script>
// run inside a webview while still blocking everything else (no external
// scripts, no unsafe-inline) -- the standard VSCode webview security pattern.
export function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
