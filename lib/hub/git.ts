import { createHash } from "node:crypto";

/** A git object as the hub stores it: the kind and the raw body, without git's header. */
export interface GitObject {
  kind: "blob" | "tree" | "commit" | "tag";
  data: Uint8Array;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export const TREE_MODE = "40000";
export const FILE_MODE = "100644";
const OID = /^[0-9a-f]{40}$/;

export function hashObject(kind: GitObject["kind"], data: Uint8Array): string {
  return createHash("sha1").update(`${kind} ${data.length}\0`).update(data).digest("hex");
}

export function isDirectoryMode(mode: string): boolean {
  return mode === TREE_MODE || mode === "040000";
}

/** Regular and executable files; symlinks (120000) and submodules (160000) are not files here. */
export function isFileMode(mode: string): boolean {
  return mode === FILE_MODE || mode === "100755";
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    const nul = data.indexOf(0, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error("Malformed git tree.");
    entries.push({
      mode: Buffer.from(data.subarray(i, space)).toString("latin1"),
      name: Buffer.from(data.subarray(space + 1, nul)).toString("utf8"),
      oid: Buffer.from(data.subarray(nul + 1, nul + 21)).toString("hex"),
    });
    i = nul + 21;
  }
  return entries;
}

/** Git orders tree entries bytewise, comparing a folder's name as if it ended in "/". */
export function serializeTree(entries: TreeEntry[]): Uint8Array {
  const sortKey = (entry: TreeEntry) => Buffer.from(entry.name + (isDirectoryMode(entry.mode) ? "/" : ""), "utf8");
  const sorted = [...entries].sort((left, right) => Buffer.compare(sortKey(left), sortKey(right)));
  return Buffer.concat(sorted.map(entry => {
    if (!OID.test(entry.oid)) throw new Error(`Invalid object id ${entry.oid}.`);
    return Buffer.concat([Buffer.from(`${isDirectoryMode(entry.mode) ? TREE_MODE : entry.mode} ${entry.name}\0`, "utf8"), Buffer.from(entry.oid, "hex")]);
  }));
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  /** Committer time in milliseconds since the epoch, or 0 when absent. */
  time: number;
}

export function parseCommit(data: Uint8Array): CommitInfo {
  const text = Buffer.from(data).toString("utf8");
  const header = text.slice(0, text.indexOf("\n\n") >= 0 ? text.indexOf("\n\n") : text.length).split("\n");
  const info: CommitInfo = { tree: "", parents: [], time: 0 };
  for (const line of header) {
    if (line.startsWith("tree ")) info.tree = line.slice(5);
    else if (line.startsWith("parent ")) info.parents.push(line.slice(7));
    else if (line.startsWith("committer ")) {
      const match = / (\d+) [+-]\d{4}$/.exec(line);
      if (match) info.time = Number(match[1]) * 1000;
    }
  }
  if (!OID.test(info.tree)) throw new Error("Malformed git commit.");
  return info;
}

export interface Signature {
  name: string;
  email: string;
  /** Seconds since the epoch. */
  when: number;
}

function signature({ name, email, when }: Signature): string {
  const clean = (value: string) => value.replace(/[<>\n]/g, "").trim() || "unknown";
  return `${clean(name)} <${clean(email)}> ${Math.floor(when)} +0000`;
}

export function serializeCommit({ tree, parents, author, message }: { tree: string; parents: string[]; author: Signature; message: string }): Uint8Array {
  const lines = [`tree ${tree}`, ...parents.map(parent => `parent ${parent}`), `author ${signature(author)}`, `committer ${signature(author)}`];
  return Buffer.from(`${lines.join("\n")}\n\n${message.trimEnd()}\n`, "utf8");
}
