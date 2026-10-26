import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { MAX_DEMO_MESSAGES, MAX_MESSAGE_LENGTH, parseDemoReplies, restoreDemoSession, sampleReply } from "../lib/demo-chat";

test("the bundled reply file provides valid prompts and existing file links", async () => {
  const raw = JSON.parse(await readFile(new URL("../workspace/Chat/replies.json", import.meta.url), "utf8"));
  const config = parseDemoReplies(raw);
  assert.ok(config);
  assert.ok(config.suggestions.length > 0);
  for (const response of [...config.rules, config.fallback]) {
    for (const link of response.links || []) {
      const { stat } = await import("node:fs/promises");
      assert.ok(await stat(new URL("../workspace/" + link.path, import.meta.url)));
    }
  }
});

test("sample replies match words and phrases case-insensitively with ordered priority", () => {
  const config = parseDemoReplies({ type: "demo-replies", rules: [
    { keywords: ["file"], content: "file reply" },
    { keywords: ["thank you"], content: "thanks reply" },
    { keywords: ["hi"], content: "hello reply" }
  ], fallback: { content: "fallback" } });
  assert.ok(config);
  assert.equal(sampleReply("Find a FILE!", config).content, "file reply");
  assert.equal(sampleReply("Thank, you!", config).content, "thanks reply");
  assert.equal(sampleReply("This is a profile", config).content, "fallback");
  assert.equal(sampleReply("Hi, show a file", config).content, "file reply");
});

test("unmatched messages use the file-provided fallback", () => {
  const config = parseDemoReplies({ type: "demo-replies", rules: [], fallback: { content: "Saved fallback", links: [{ label: "Guide", path: "Files/Welcome.md" }] } });
  assert.ok(config);
  assert.deepEqual(sampleReply("anything", config), config.fallback);
});

test("malformed reply configurations do not enable chat", () => {
  for (const value of [null, {}, { type: "demo-replies", rules: [], fallback: { content: 1 } },
    { type: "demo-replies", rules: [{ keywords: [""], content: "bad" }], fallback: { content: "ok" } },
    { type: "demo-replies", rules: [], fallback: { content: "ok", links: false } }]) assert.equal(parseDemoReplies(value), undefined);
});

test("stored demo sessions reject malformed messages and restore only bounded local turns", () => {
  assert.deepEqual(restoreDemoSession({ version: 9, messages: [] }), { messages: [], draft: "" });
  const messages = Array.from({ length: MAX_DEMO_MESSAGES + 2 }, (_, i) => ({ id: String(i), role: "user", content: "x".repeat(MAX_MESSAGE_LENGTH + 1) }));
  const restored = restoreDemoSession({ version: 1, messages: [...messages, { id: "bad", role: "system", content: "not local" }], draft: "d".repeat(MAX_MESSAGE_LENGTH + 5) });
  assert.equal(restored.messages.length, MAX_DEMO_MESSAGES);
  assert.equal(restored.messages[0].id, "2");
  assert.equal(restored.messages[0].content.length, MAX_MESSAGE_LENGTH);
  assert.equal(restored.draft.length, MAX_MESSAGE_LENGTH);
});
