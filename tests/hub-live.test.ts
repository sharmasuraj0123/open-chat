import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { hubConfig } from "../lib/hub/config";
import { SpacetimeHub } from "../lib/hub/spacetime";
import { appendHubChat, loadHubWorkspace } from "../lib/hub/workspace";
import { chatLogPath, parseChatLog } from "../lib/chat-log";

// Opt-in: this writes to a real hub. For example, against a local spacehub server:
//   OPEN_CHAT_HUB_TEST_SPACE=quirq OPEN_CHAT_HUB_TEST_CONVERSATION=quirq/Chat/index.json \
//   SPACEHUB_SERVER=ws://127.0.0.1:3000 SPACEHUB_TOKEN=... npm test
const space = process.env.OPEN_CHAT_HUB_TEST_SPACE;
const conversation = process.env.OPEN_CHAT_HUB_TEST_CONVERSATION;
const skip = !space || !conversation ? "set OPEN_CHAT_HUB_TEST_SPACE and OPEN_CHAT_HUB_TEST_CONVERSATION to run against a real hub" : false;

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, seconds = 15): Promise<T> {
  for (let tries = seconds * 4; ; tries--) {
    const value = await read();
    if (done(value) || tries <= 0) return value;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

test("a live hub: chats saved by one connection reach another, and pushes arrive on their own", { skip }, async t => {
  const config = hubConfig({ ...process.env, SPACEHUB_SPACE: space })!;
  const logPath = chatLogPath(conversation!)!;
  const turns = async (hub: SpacetimeHub) => {
    try { return parseChatLog((await loadHubWorkspace(hub, logPath)).file?.content ?? "").map(turn => turn.id); }
    catch { return []; }
  };
  const laptop = new SpacetimeHub(config);
  const phone = new SpacetimeHub(config);
  const viewer = new SpacetimeHub({ ...config, token: undefined });
  t.after(() => Promise.all([laptop.close(), phone.close(), viewer.close()]));

  assert.ok((await loadHubWorkspace(laptop)).roots.length > 0);
  assert.ok(await laptop.author(), "the token must belong to a builder or agent that can push to the space");
  const before = await turns(laptop);

  const first = randomUUID();
  await appendHubChat(laptop, conversation!, [{ id: first, role: "user", content: `live test ${first}` }]);
  // A signed-out viewer with a cold cache reads it, as another device would.
  assert.ok((await eventually(() => turns(viewer), ids => ids.includes(first))).includes(first));

  // The laptop's warm cache follows a push it did not make.
  const second = randomUUID();
  await appendHubChat(phone, conversation!, [{ id: second, role: "assistant", content: `reply ${second}` }]);
  const after = await eventually(() => turns(laptop), ids => ids.includes(second));
  assert.deepEqual(after.slice(before.length), [first, second]);
});
