import DOMPurify from "dompurify";

export const workspaceImageTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
export const workspaceTextExtensions =
  /\.(txt|md|markdown|json|jsonl|csv|tsv|log|py|js|jsx|ts|tsx|sh|bash|zsh|yaml|yml|toml|ini|cfg|conf|xml|html|htm|css|sql|rs|go|java|c|cpp|h|http|env)$/i;
export function workspaceLanguage(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return (
    (
      {
        js: "javascript",
        jsx: "jsx",
        ts: "typescript",
        tsx: "tsx",
        py: "python",
        sh: "bash",
        rs: "rust",
        md: "markdown",
        htm: "html",
        yml: "yaml",
      } as Record<string, string>
    )[extension] ?? extension
  );
}

/** Untrusted documents are static, offline previews. Strip active/navigation
 * elements and resource attributes before placing them in an opaque iframe.
 * The CSP is a second boundary against styles or markup fetching resources. */
export function workspacePreviewDocument(html: string): string {
  const clean = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: [
      "style",
      "script",
      "iframe",
      "object",
      "embed",
      "base",
      "meta",
      "link",
      "form",
      "input",
      "button",
      "textarea",
      "select",
      "video",
      "audio",
      "source",
    ],
    FORBID_ATTR: [
      "href",
      "src",
      "srcset",
      "action",
      "formaction",
      "style",
      "background",
      "poster",
      "ping",
    ],
  });
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"><style>body{font:14px/1.6 system-ui;margin:16px;overflow-wrap:anywhere;color:#171717;background:#fff}pre{white-space:pre-wrap;background:#f4f4f5;padding:12px}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid #ddd;padding:6px}img{max-width:100%}</style></head><body>${clean}</body></html>`;
}
