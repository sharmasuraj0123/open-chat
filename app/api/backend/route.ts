import { safeMirrorError } from "../../../lib/filesystem";
import { sameOrigin } from "../../../lib/observation-root";
import { hubSource } from "../../../lib/backend";
import { safeHubError } from "../../../lib/hub/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Vary: "Origin, Sec-Fetch-Site" };

/** Which backend serves the workspace and, on the hub, whether it is connected and who saves. Never the token. */
export async function GET(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return Response.json({ error: "Cross-origin access is not allowed." }, { status: 403, headers });
  try {
    const hub = hubSource();
    if (!hub) return Response.json({ kind: "files" }, { headers });
    let author: string | null = null;
    let error = "";
    try { author = (await hub.author()) ?? null; } catch (cause) { error = safeHubError(cause).message; }
    const status = hub.status?.();
    return Response.json({
      kind: "hub",
      host: hub.host,
      target: hub.project ? `${hub.space}/${hub.project}` : hub.space,
      state: error ? "offline" : status?.state ?? "live",
      error: error || status?.error || "",
      author,
    }, { headers });
  } catch (error) {
    const safe = safeMirrorError(error);
    return Response.json({ error: safe.message }, { status: safe.status, headers });
  }
}
