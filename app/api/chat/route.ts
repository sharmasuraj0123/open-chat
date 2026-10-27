import { MirrorError, safeMirrorError } from "../../../lib/filesystem";
import { hubRoot, sameOrigin } from "../../../lib/observation-root";
import { hubSource } from "../../../lib/backend";
import { appendHubChat } from "../../../lib/hub/workspace";
import { MAX_TURNS_PER_REQUEST, parseTurn } from "../../../lib/chat-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Vary: "Origin, Sec-Fetch-Site, Cookie" };

/** Save chat turns beside a conversation file. Only the hub backend writes; the file-system backend stays read-only. */
export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request) || request.headers.get("content-type")?.split(";")[0] !== "application/json") return Response.json({ error: "A same-origin JSON request is required." }, { status: 403, headers });
  try {
    const hub = hubSource();
    if (!hub) throw new MirrorError("Chats are saved only with the hub backend. Set SPACEHUB_SPACE to use it.", 409);
    const text = await request.text();
    if (text.length > 64 * 1024) throw new MirrorError("This message is too long.", 413);
    let input: unknown;
    try { input = JSON.parse(text); } catch { throw new MirrorError("Invalid chat message."); }
    if (!input || typeof input !== "object" || !("path" in input) || typeof input.path !== "string" || !("messages" in input) || !Array.isArray(input.messages)) throw new MirrorError("Send a conversation path and its new messages.");
    if (!input.messages.length || input.messages.length > MAX_TURNS_PER_REQUEST) throw new MirrorError(`Send 1 to ${MAX_TURNS_PER_REQUEST} messages at a time.`);
    const turns = input.messages.map(parseTurn);
    if (turns.some(turn => !turn)) throw new MirrorError("Each message needs an id, a user or assistant role and text of at most 4,000 characters.");
    const saved = await appendHubChat(hub, input.path, turns.filter(turn => turn !== undefined), hubRoot(request));
    return Response.json(saved, { headers });
  } catch (error) {
    const safe = safeMirrorError(error);
    return Response.json({ error: safe.message }, { status: safe.status, headers });
  }
}
