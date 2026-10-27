import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FILE_MODE, TREE_MODE, hashObject, parseCommit, parseTree, serializeCommit, serializeTree } from "../lib/hub/git";

function git(cwd: string, args: string[], input?: string | Buffer, env: Record<string, string> = {}): string {
  return execFileSync("git", args, { cwd, input, env: { ...process.env, ...env }, encoding: "utf8" }).trim();
}

test("objects built for the hub hash exactly as git hashes them", async t => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "open-chat-git-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  git(repo, ["init", "-q"]);
  const write = (kind: string, data: Uint8Array) => git(repo, ["hash-object", "-w", "-t", kind, "--stdin"], Buffer.from(data));

  const text = Buffer.from("{\"role\":\"user\",\"content\":\"héllo\"}\n");
  const blob = hashObject("blob", text);
  assert.equal(write("blob", text), blob);

  // Git sorts a folder as if its name ended in "/": "a-b" < "a.txt" < "a/" < "a0".
  const inner = serializeTree([{ mode: FILE_MODE, name: "note.md", oid: blob }]);
  const innerOid = write("tree", inner);
  assert.equal(hashObject("tree", inner), innerOid);
  const entries = [
    { mode: FILE_MODE, name: "a0", oid: blob },
    { mode: TREE_MODE, name: "a", oid: innerOid },
    { mode: FILE_MODE, name: "a.txt", oid: blob },
    { mode: FILE_MODE, name: "a-b", oid: blob },
  ];
  const tree = serializeTree(entries);
  const mktree = git(repo, ["mktree"], `100644 blob ${blob}\ta0\n040000 tree ${innerOid}\ta\n100644 blob ${blob}\ta.txt\n100644 blob ${blob}\ta-b\n`);
  assert.equal(hashObject("tree", tree), mktree);
  assert.deepEqual(parseTree(tree).map(entry => entry.name), ["a-b", "a.txt", "a", "a0"]);
  assert.deepEqual(parseTree(tree).find(entry => entry.name === "a"), { mode: TREE_MODE, name: "a", oid: innerOid });

  const commit = serializeCommit({ tree: mktree, parents: [], author: { name: "suraj", email: "suraj@hub.quirq.dev", when: 1_800_000_000 }, message: "chat: 1 message" });
  const viaGit = git(repo, ["commit-tree", mktree, "-m", "chat: 1 message"], undefined, {
    GIT_AUTHOR_NAME: "suraj", GIT_AUTHOR_EMAIL: "suraj@hub.quirq.dev", GIT_AUTHOR_DATE: "1800000000 +0000",
    GIT_COMMITTER_NAME: "suraj", GIT_COMMITTER_EMAIL: "suraj@hub.quirq.dev", GIT_COMMITTER_DATE: "1800000000 +0000",
  });
  assert.equal(hashObject("commit", commit), viaGit);
  assert.deepEqual(parseCommit(commit), { tree: mktree, parents: [], time: 1_800_000_000_000 });

  const child = serializeCommit({ tree: mktree, parents: [viaGit], author: { name: "a <b>\n", email: "x", when: 1_800_000_001 }, message: "next" });
  assert.equal(write("commit", child), hashObject("commit", child));
  git(repo, ["update-ref", "refs/heads/main", hashObject("commit", child)]);
  git(repo, ["fsck", "--strict", "--no-dangling"]);
  assert.equal(git(repo, ["show", "main:a/note.md"]), text.toString().trim());
});

test("malformed trees and commits are rejected", () => {
  assert.throws(() => parseTree(Buffer.from("100644 name-without-oid")), /Malformed/);
  assert.throws(() => parseCommit(Buffer.from("author x\n\nmessage")), /Malformed/);
  assert.throws(() => serializeTree([{ mode: FILE_MODE, name: "x", oid: "not-an-oid" }]), /Invalid object id/);
});
