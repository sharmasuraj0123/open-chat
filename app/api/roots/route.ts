import path from "node:path";
import { loadWorkspace, resolveObservationDirectory, safeMirrorError, MirrorError } from "../../../lib/filesystem";
import { browseBase, HUB_ROOT_COOKIE, hubRoot, observationRoot, ROOT_COOKIE, sameOrigin } from "../../../lib/observation-root";
import { hubSource } from "../../../lib/backend";
import { loadHubWorkspace, resolveHubDirectory, type HubSource } from "../../../lib/hub/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Vary: "Origin, Sec-Fetch-Site, Cookie" };

function rootCookie(name: string, value: string, request: Request) {
  return name + "=" + encodeURIComponent(value) + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000" + (new URL(request.url).protocol === "https:" ? "; Secure" : "");
}

/** On the hub the picker browses the space (or project); a selection is a folder path inside it. */
async function hubListing(hub: HubSource, request: Request, relative: string) {
  const snapshot = await loadHubWorkspace(hub, await resolveHubDirectory(hub, relative), "");
  let selected: string | null = null;
  try { selected = hubRoot(request); } catch { /* An unusable old selection just shows nothing as current. */ }
  return { baseName: hub.project || hub.space, path: snapshot.directory.path, selected, directories: snapshot.directory.entries.filter(entry => entry.kind === "directory") };
}

export async function GET(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Cross-origin folder access is not allowed." }, { status: 403, headers });
  try {
    const relative = new URL(request.url).searchParams.get("path") ?? "";
    const hub = hubSource();
    if (hub) return Response.json(await hubListing(hub, request, relative), { headers });
    const base = await resolveObservationDirectory("", browseBase());
    await resolveObservationDirectory(relative, base);
    const snapshot = await loadWorkspace(relative, base);
    let selected: string | null = null;
    try {
      const current = await observationRoot(request) || await resolveObservationDirectory("");
      const candidate = path.relative(base, current).split(path.sep).join("/");
      if (candidate !== ".." && !candidate.startsWith("../") && !path.isAbsolute(candidate)) selected = candidate;
    } catch { /* Keep the picker usable when a previously selected folder was removed. */ }
    return Response.json({ baseName: path.basename(base), path: snapshot.directory.path, selected, directories: snapshot.directory.entries.filter(entry => entry.kind === "directory") }, { headers });
  } catch (error) { const safe = safeMirrorError(error); return Response.json({ error: safe.message }, { status: safe.status, headers }); }
}

export async function POST(request: Request) {
  if (!sameOrigin(request) || request.headers.get("content-type")?.split(";")[0] !== "application/json") return Response.json({ error: "A same-origin JSON request is required." }, { status: 403, headers });
  try {
    const text = await request.text();
    if (text.length > 4096) throw new MirrorError("Folder selection is too long.");
    let input: unknown;
    try { input = JSON.parse(text); } catch { throw new MirrorError("Invalid folder selection."); }
    if (!input || typeof input !== "object" || !("path" in input) || typeof input.path !== "string") throw new MirrorError("Choose a folder path.");
    const hub = hubSource();
    if (hub) {
      const chosen = await resolveHubDirectory(hub, input.path);
      return Response.json({ name: chosen ? path.posix.basename(chosen) : hub.project || hub.space }, { headers: { ...headers, "Set-Cookie": rootCookie(HUB_ROOT_COOKIE, chosen, request) } });
    }
    const base = await resolveObservationDirectory("", browseBase());
    const chosen = await resolveObservationDirectory(input.path, base);
    const relative = path.relative(base, chosen).split(path.sep).join("/");
    return Response.json({ name: path.basename(chosen) }, { headers: { ...headers, "Set-Cookie": rootCookie(ROOT_COOKIE, relative, request) } });
  } catch (error) { const safe = safeMirrorError(error); return Response.json({ error: safe.message }, { status: safe.status, headers }); }
}
