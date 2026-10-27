import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { hubConfig } from "../lib/hub/config";
import { setHubSourceForTests } from "../lib/backend";
import { GET as workspace } from "../app/api/workspace/route";
import { GET as preview } from "../app/api/file/route";
import { GET as roots, POST as chooseRoot } from "../app/api/roots/route";
import { POST as chat } from "../app/api/chat/route";
import { GET as backend } from "../app/api/backend/route";
import { MemoryHub } from "./helpers/memory-hub";

test("SPACEHUB_SPACE picks the hub backend; the token comes from the env or spacehub's saved login", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "open-chat-spacehub-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, "config.json"), JSON.stringify({ server: "wss://elsewhere.test", tokens: { "wss://hub.quirq.dev": "saved-token", "wss://elsewhere.test": "other" } }));
  assert.equal(hubConfig({}), undefined);
  assert.equal(hubConfig({ SPACEHUB_SPACE: "  " }), undefined);
  assert.deepEqual(hubConfig({ SPACEHUB_SPACE: "Quirq", SPACEHUB_HOME: home }), { server: "wss://hub.quirq.dev", database: "spacehub", token: "saved-token", space: "quirq" });
  assert.deepEqual(hubConfig({ SPACEHUB_SPACE: "quirq/quirq", SPACEHUB_SERVER: "https://hub.example.com/", SPACEHUB_DB: "hub2", SPACEHUB_TOKEN: "env-token", SPACEHUB_HOME: home }),
    { server: "wss://hub.example.com", database: "hub2", token: "env-token", space: "quirq", project: "quirq" });
  assert.equal(hubConfig({ SPACEHUB_SPACE: "quirq", SPACEHUB_HOME: path.join(home, "none") })?.token, undefined);
  for (const bad of ["../x", "quirq/a/b", "quirq/", "-x", "quirq/a b"]) assert.throws(() => hubConfig({ SPACEHUB_SPACE: bad }), /SPACEHUB_SPACE/);
  assert.throws(() => hubConfig({ SPACEHUB_SPACE: "quirq", SPACEHUB_SERVER: "ftp://x" }), /SPACEHUB_SERVER/);
});

test("the routes serve the space, save chats and report the backend, never the token", async t => {
  const hub = new MemoryHub("quirq");
  hub.commit("quirq", { "Chat/index.json": JSON.stringify({ type: "conversation", messages: [] }), "Library/logo.png": Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) });
  setHubSourceForTests(hub);
  t.after(() => setHubSourceForTests(undefined));
  const get = (handler: (request: Request) => Promise<Response>, url: string, headers: Record<string, string> = {}) => handler(new Request("http://localhost" + url, { headers }));

  const top = await (await get(workspace, "/api/workspace")).json();
  assert.deepEqual(top.roots.map((entry: { name: string }) => entry.name), ["quirq"]);
  assert.equal((await get(preview, "/api/file?path=quirq/Library/logo.png")).headers.get("content-type"), "image/png");

  const listing = await (await get(roots, "/api/roots?path=quirq")).json();
  assert.equal(listing.baseName, "quirq");
  assert.deepEqual(listing.directories.map((entry: { name: string }) => entry.name), ["Chat", "Library"]);
  const select = (body: unknown) => chooseRoot(new Request("http://localhost/api/roots", { method: "POST", headers: { "Content-Type": "application/json", origin: "http://localhost" }, body: JSON.stringify(body) }));
  assert.equal((await select({ path: "quirq/Chat/index.json" })).status, 400);
  const chosen = await select({ path: "quirq" });
  const cookie = chosen.headers.get("set-cookie")!;
  assert.match(cookie, /^open-chat-hub-root=quirq; Path=\/; HttpOnly; SameSite=Strict/);
  const scoped = await (await get(workspace, "/api/workspace", { cookie: cookie.split(";")[0] })).json();
  assert.deepEqual(scoped.roots.map((entry: { name: string }) => entry.name), ["Chat", "Library"]);
  assert.equal((await get(workspace, "/api/workspace", { cookie: "open-chat-hub-root=..%2Fx" })).status, 400);

  const send = (body: unknown, headers: Record<string, string> = { "Content-Type": "application/json", origin: "http://localhost", cookie: cookie.split(";")[0] }) =>
    chat(new Request("http://localhost/api/chat", { method: "POST", headers, body: JSON.stringify(body) }));
  const ok = await send({ path: "Chat/index.json", messages: [{ id: "m1", role: "user", content: "hello hub" }] });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).path, "Chat/index.log.jsonl");
  const log = await (await get(workspace, "/api/workspace?path=quirq/Chat/index.log.jsonl")).json();
  assert.match(log.file.content, /"content":"hello hub"/);
  assert.equal((await send({ path: "Chat/index.json", messages: [{ id: "m2", role: "system", content: "x" }] })).status, 400);
  assert.equal((await send({ path: "Chat/index.json", messages: [{ id: "m3", role: "user", content: "x".repeat(4001) }] })).status, 400);
  assert.equal((await send({ path: "Chat/index.json", messages: [] })).status, 400);
  assert.equal((await send({ path: "Chat/index.json", messages: [{ id: "m4", role: "user", content: "x" }] }, { "Content-Type": "application/json", origin: "http://evil.test" })).status, 403);
  assert.equal((await send({ path: "Chat/index.json", messages: [{ id: "m5", role: "user", content: "x" }] }, { "Content-Type": "text/plain", origin: "http://localhost" })).status, 403);

  const info = await (await get(backend, "/api/backend")).json();
  assert.deepEqual(info, { kind: "hub", host: "hub.test", target: "quirq", state: "live", error: "", author: "suraj" });

  // The file-system backend stays read-only.
  setHubSourceForTests(null);
  assert.deepEqual(await (await get(backend, "/api/backend")).json(), { kind: "files" });
  assert.equal((await send({ path: "Chat/index.json", messages: [{ id: "m6", role: "user", content: "x" }] })).status, 409);
});
