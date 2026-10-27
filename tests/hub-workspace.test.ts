import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { appendHubChat, loadHubWorkspace, readHubPreview, resolveHubDirectory } from "../lib/hub/workspace";
import { parseCommit } from "../lib/hub/git";
import { parseChatLog } from "../lib/chat-log";
import { MAX_TEXT_BYTES } from "../lib/filesystem";
import { MemoryHub } from "./helpers/memory-hub";

const conversation = JSON.stringify({ type: "conversation", title: "quirq chat", messages: [{ role: "assistant", content: "Hi from the hub." }] });
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);

function quirqSpace() {
  const hub = new MemoryHub("quirq");
  hub.commit("quirq", {
    "README.md": "# quirq",
    "Chat/index.json": conversation,
    "Activity/example.jsonl": "{\"author\":\"suraj\",\"content\":\"first\"}\n",
    "Library/logo.png": png,
    "Library/fake.png": "not an image",
    ".private/token.txt": "secret",
    "link-out": { symlink: "/etc/passwd" },
  });
  hub.commit("notes", { "todo.md": "- [ ] ship" });
  return hub;
}

const status = async (promise: Promise<unknown>) => promise.then(() => 200, (error: { status?: number }) => error.status ?? 0);

test("a space reads like a folder of projects, each showing its default branch", async () => {
  const hub = quirqSpace();
  const top = await loadHubWorkspace(hub);
  assert.equal(top.rootName, "quirq");
  assert.deepEqual(top.roots.map(entry => entry.name), ["notes", "quirq"]);

  const chat = await loadHubWorkspace(hub, "quirq/Chat/index.json");
  assert.equal(chat.file?.format, "json");
  assert.equal((chat.file?.data as { title: string }).title, "quirq chat");
  assert.equal(chat.directory.path, "quirq/Chat");
  assert.equal(chat.file?.size, Buffer.byteLength(conversation));

  const project = await loadHubWorkspace(hub, "quirq");
  // Hidden names and symlinks stay out of the workspace, as on disk.
  assert.deepEqual(project.directory.entries.map(entry => entry.name), ["Activity", "Chat", "Library", "README.md"]);
  assert.equal(await status(loadHubWorkspace(hub, "quirq/.private/token.txt")), 403);
  assert.equal(await status(loadHubWorkspace(hub, "quirq/link-out")), 404);
  assert.equal(await status(loadHubWorkspace(hub, "quirq/../notes")), 400);
  assert.equal(await status(loadHubWorkspace(hub, "nothing")), 404);
});

test("an observed folder and a one-project backend scope paths like MIRROR_ROOT", async () => {
  const hub = quirqSpace();
  const scoped = await loadHubWorkspace(hub, "Chat/index.json", "quirq");
  assert.equal(scoped.rootName, "quirq");
  assert.deepEqual(scoped.roots.map(entry => entry.name), ["Activity", "Chat", "Library"]);
  assert.equal(scoped.file?.path, "Chat/index.json");
  assert.notEqual(scoped.rootId, (await loadHubWorkspace(hub)).rootId);
  assert.equal(await status(loadHubWorkspace(hub, "", "quirq/README.md")), 400);
  assert.equal(await resolveHubDirectory(hub, "quirq/Chat"), "quirq/Chat");
  assert.equal(await status(resolveHubDirectory(hub, "quirq/README.md")), 400);

  const one = new MemoryHub("quirq", "quirq");
  one.commit("quirq", { "Chat/index.json": conversation });
  one.commit("other", { "x.md": "x" });
  const root = await loadHubWorkspace(one);
  assert.equal(root.rootName, "quirq");
  assert.deepEqual(root.roots.map(entry => entry.name), ["Chat"]);
});

test("previews check signatures and size limits, and pushes change the revision", async () => {
  const hub = quirqSpace();
  const preview = await readHubPreview(hub, "quirq/Library/logo.png");
  assert.equal(preview.contentType, "image/png");
  assert.equal(await status(readHubPreview(hub, "quirq/Library/fake.png")), 415);
  assert.equal(await status(readHubPreview(hub, "quirq/README.md")), 415);

  const before = await loadHubWorkspace(hub, "quirq/README.md");
  hub.commit("quirq", { "README.md": "# quirq, edited elsewhere", "big.txt": "x".repeat(MAX_TEXT_BYTES + 1) });
  const after = await loadHubWorkspace(hub, "quirq/README.md");
  assert.equal(after.file?.content, "# quirq, edited elsewhere");
  assert.notEqual(after.revision, before.revision);
  assert.match((await loadHubWorkspace(hub, "quirq/big.txt")).file?.error ?? "", /2 MB/);
});

test("chat turns are committed to a log beside the conversation and read back", async t => {
  const hub = quirqSpace();
  const head = hub.heads.get("quirq/quirq")!;
  const saved = await appendHubChat(hub, "Chat/index.json", [{ id: "u1", role: "user", content: "Where is the brief?" }], "quirq");
  assert.equal(saved.path, "Chat/index.log.jsonl");
  assert.deepEqual(parseCommit(hub.objects.get(saved.commit)!.data).parents, [head]);

  await appendHubChat(hub, "quirq/Chat/index.json", [{ id: "a1", role: "assistant", content: "In Files.", links: [{ label: "Brief", path: "Files/Brief.md" }] }]);
  const log = await loadHubWorkspace(hub, "quirq/Chat/index.log.jsonl");
  assert.equal(log.file?.format, "jsonl");
  const turns = parseChatLog(log.file?.content ?? "");
  assert.deepEqual(turns.map(turn => [turn.id, turn.role, turn.author]), [["u1", "user", "suraj"], ["a1", "assistant", "quirqy"]]);
  assert.deepEqual(turns[1].links, [{ label: "Brief", path: "Files/Brief.md" }]);
  // The rest of the project is untouched.
  assert.equal((await loadHubWorkspace(hub, "quirq/README.md")).file?.content, "# quirq");
  assert.equal((await loadHubWorkspace(hub, "quirq/Library/logo.png")).file?.size, png.length);

  // Everything the backend wrote is a valid git history.
  const repo = await mkdtemp(path.join(os.tmpdir(), "open-chat-hub-fsck-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  for (const [oid, object] of hub.objects) {
    assert.equal(execFileSync("git", ["hash-object", "-w", "-t", object.kind, "--stdin"], { cwd: repo, input: Buffer.from(object.data), encoding: "utf8" }).trim(), oid);
  }
  execFileSync("git", ["update-ref", "refs/heads/main", hub.heads.get("quirq/quirq")!], { cwd: repo });
  execFileSync("git", ["fsck", "--strict", "--no-dangling"], { cwd: repo });
  assert.equal(execFileSync("git", ["log", "--format=%an %s", "main", "-1"], { cwd: repo, encoding: "utf8" }).trim(), "suraj chat: 1 message in Chat/index.log.jsonl");
});

test("a push that lands first is kept: the turn is appended again on top of it", async () => {
  const hub = quirqSpace();
  await appendHubChat(hub, "quirq/Chat/index.json", [{ id: "first", role: "user", content: "one" }]);
  let raced = false;
  hub.beforePush = async () => {
    if (raced) return;
    raced = true;
    // Another device saves its own turn between our read and our push.
    hub.beforePush = undefined;
    await appendHubChat(hub, "quirq/Chat/index.json", [{ id: "other", role: "user", content: "from my phone" }]);
    hub.beforePush = async () => {};
  };
  await appendHubChat(hub, "quirq/Chat/index.json", [{ id: "mine", role: "user", content: "from my laptop" }]);
  const turns = parseChatLog((await loadHubWorkspace(hub, "quirq/Chat/index.log.jsonl")).file?.content ?? "");
  assert.deepEqual(turns.map(turn => turn.id), ["first", "other", "mine"]);
});

test("saving refuses what it must not write", async () => {
  const hub = quirqSpace();
  const turn = [{ id: "x", role: "user" as const, content: "hi" }];
  assert.equal(await status(appendHubChat(hub, "quirq/README.md", turn)), 400);
  assert.equal(await status(appendHubChat(hub, "quirq/Activity/example.jsonl", turn)), 400);
  assert.equal(await status(appendHubChat(hub, "quirq/Chat/missing.json", turn)), 404);
  assert.equal(await status(appendHubChat(hub, "quirq/../notes/x.json", turn)), 400);
  hub.refuse = "permission denied: you are not an owner or member of \"quirq\"";
  assert.equal(await status(appendHubChat(hub, "quirq/Chat/index.json", turn)), 403);
  hub.refuse = undefined;
  hub.user = undefined;
  assert.equal(await status(appendHubChat(hub, "quirq/Chat/index.json", turn)), 401);
  assert.equal(hub.pushes.length, 0);
});
