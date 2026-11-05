import { app, protocol } from "electron";
import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import type { SessionUpdate } from "./acp";

/** Pages an agent drew with `show_visual`, served to sandboxed frames in the chat. */
export const VISUAL_SCHEME = "workbench-visual";

// Inline code and the common CDNs only. The page may not call out anywhere else.
const VISUAL_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com",
  "style-src 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com",
  "font-src https://fonts.gstatic.com data:",
  "img-src data: blob: https:",
].join("; ");

// Reports the page height so the chat can size the frame to fit.
const SIZER = `<script>(function(){function send(){parent.postMessage({type:'workbench-visual-height',height:Math.ceil(document.documentElement.scrollHeight)},'*')}new ResizeObserver(send).observe(document.documentElement);addEventListener('load',send);send()})()</script>`;

const ID = /^[0-9a-f-]{36}$/;

function visualsDir(): string {
  return join(app.getPath("userData"), "workbench", "visuals");
}

export function visualSchemePrivilege(): {
  scheme: string;
  privileges: { standard: boolean; secure: boolean };
} {
  return {
    scheme: VISUAL_SCHEME,
    privileges: { standard: true, secure: true },
  };
}

/** Store the page and return the fenced block the chat renders as a frame. */
export function saveVisual(html: string, title?: string): string {
  const id = randomUUID();
  mkdirSync(visualsDir(), { recursive: true });
  writeFileSync(join(visualsDir(), `${id}.html`), html, "utf8");
  return `\n\n\`\`\`visual\n${JSON.stringify({ id, title: title?.trim() || undefined })}\n\`\`\`\n\n`;
}

export function attachVisualProtocol(): void {
  protocol.handle(VISUAL_SCHEME, async (request) => {
    const id = new URL(request.url).pathname.replace(/^\/+/, "");
    if (!ID.test(id)) return new Response("Not found", { status: 404 });
    let html: string;
    try {
      html = await readFile(join(visualsDir(), `${id}.html`), "utf8");
    } catch {
      return new Response("This visual is no longer on disk.", { status: 404 });
    }
    return new Response(html + SIZER, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": VISUAL_CSP,
      },
    });
  });
}

/** A `show_visual` call with its HTML, from either agent's naming of the browser MCP tool. */
export function visualFromUpdate(
  update: SessionUpdate["update"],
): { html: string; title?: string } | null {
  const named = [update.name, update.title].some((value) =>
    /show[_ ]visual/i.test(value ?? ""),
  );
  if (!named) return null;
  const input = update.rawInput;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const { html, title } = input as { html?: unknown; title?: unknown };
  if (typeof html !== "string" || !html.trim()) return null;
  return { html, title: typeof title === "string" ? title : undefined };
}
