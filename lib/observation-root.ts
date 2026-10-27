import path from "node:path";
import { MirrorError, relativePath, resolveObservationDirectory } from "./filesystem";

export const ROOT_COOKIE = "open-chat-root";
export function sameOrigin(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const target = new URL(request.url);
  // Next dev can normalize request.url to localhost; Host retains the browser-facing address.
  if (request.headers.get("host")) target.host = request.headers.get("host")!;
  return origin === target.origin;
}
export function browseBase(): string {
  return process.env.MIRROR_BROWSE_ROOT || process.env.MIRROR_ROOT || path.join(process.cwd(), "workspace");
}
function cookieValue(request: Request, name: string): string | undefined {
  const cookie = request.headers.get("cookie")?.split(";").map(value => value.trim()).find(value => value.startsWith(name + "="));
  if (!cookie) return undefined;
  try { return decodeURIComponent(cookie.slice(name.length + 1)); }
  catch { throw new MirrorError("Invalid workspace selection. Choose a folder again."); }
}
export async function observationRoot(request: Request): Promise<string | undefined> {
  const selected = cookieValue(request, ROOT_COOKIE);
  return selected === undefined ? undefined : resolveObservationDirectory(selected, browseBase());
}
/** The hub backend keeps its own selection: a folder path inside the space (or project). */
export const HUB_ROOT_COOKIE = "open-chat-hub-root";
export function hubRoot(request: Request): string {
  return relativePath(cookieValue(request, HUB_ROOT_COOKIE) ?? "");
}
