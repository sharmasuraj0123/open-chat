import { createHash } from "node:crypto";
import path from "node:path";
import {
  MAX_DIRECTORY_ENTRIES, MAX_PREVIEW_BYTES, MAX_TEXT_BYTES, MirrorError, buildFileView, compareEntries,
  isVisibleName, matchesMime, previewContentType, relativePath, withRevision,
} from "../filesystem";
import { chatLogLine, chatLogPath, type ChatTurn } from "../chat-log";
import { isConversation } from "../conversation";
import type { Entry, PreviewResult, WorkspaceSnapshot } from "../types";
import {
  FILE_MODE, TREE_MODE, hashObject, isDirectoryMode, isFileMode, parseCommit, parseTree,
  serializeCommit, serializeTree, type GitObject, type TreeEntry,
} from "./git";

export interface HubProject {
  name: string;
  fullName: string;
  defaultBranch: string;
  /** ISO time of the last push. */
  pushedAt: string;
}

export type StoredObject = GitObject & { oid: string };

/** What the workspace needs from a hub: SpacetimeDB in the app, an in-memory hub in tests. */
export interface HubSource {
  /** Distinguishes roots on different hubs and spaces. */
  readonly id: string;
  /** The hub's host, for commit e-mail addresses. */
  readonly host: string;
  readonly space: string;
  /** Set when the workspace is one project rather than the whole space. */
  readonly project?: string;
  projects(): Promise<HubProject[]>;
  /** The default branch's commit, or "" while the project is empty. */
  head(fullName: string): Promise<string>;
  object(fullName: string, oid: string): Promise<GitObject>;
  /** Upload objects, then move the branch only if it still points at `oldOid`. */
  push(fullName: string, objects: StoredObject[], branch: string, oldOid: string, newOid: string): Promise<void>;
  /** The builder (or agent) this backend saves as, or undefined without a sign-in. */
  author(): Promise<string | undefined>;
  /** The connection's state, for the status badge. */
  status?(): { state: string; error: string };
}

type Located =
  | { kind: "space" }
  | { kind: "directory"; project: HubProject; inner: string; tree: TreeEntry[]; time: string }
  | { kind: "file"; project: HubProject; inner: string; oid: string; mode: string; time: string };

const notFound = () => new MirrorError("The requested file or folder was not found.", 404);
const join = (...parts: string[]) => parts.filter(Boolean).join("/");

/** Hub failures carry no local paths, so their message is safe to show. */
export function safeHubError(error: unknown): MirrorError {
  if (error instanceof MirrorError) return error;
  const message = error instanceof Error ? error.message.replace(/^Error: /, "") : String(error);
  return new MirrorError(`The hub could not be reached or read: ${message}`, 503);
}

async function findProject(source: HubSource, name: string): Promise<HubProject> {
  const fullName = source.project ? `${source.space}/${source.project}` : `${source.space}/${name}`;
  const project = (await source.projects()).find(candidate => candidate.fullName === fullName);
  if (!project) throw notFound();
  return project;
}

async function rootTree(source: HubSource, project: HubProject): Promise<{ head: string; tree: string; time: string }> {
  const head = await source.head(project.fullName);
  if (!head) return { head, tree: "", time: project.pushedAt };
  const commit = parseCommit((await source.object(project.fullName, head)).data);
  return { head, tree: commit.tree, time: commit.time ? new Date(commit.time).toISOString() : project.pushedAt };
}

async function readTree(source: HubSource, project: HubProject, oid: string): Promise<TreeEntry[]> {
  if (!oid) return [];
  const object = await source.object(project.fullName, oid);
  if (object.kind !== "tree") throw new MirrorError("The hub returned a damaged folder.", 502);
  return parseTree(object.data);
}

/** Walk a virtual path: the space's projects, then each project's default branch. */
async function locate(source: HubSource, full: string): Promise<Located> {
  const parts = full.split("/").filter(Boolean);
  if (!source.project && !parts.length) return { kind: "space" };
  const project = await findProject(source, source.project ? "" : parts[0]);
  const innerParts = source.project ? parts : parts.slice(1);
  const { tree: rootOid, time } = await rootTree(source, project);
  let tree = await readTree(source, project, rootOid);
  for (let i = 0; i < innerParts.length; i++) {
    const entry = tree.find(candidate => candidate.name === innerParts[i]);
    if (!entry) throw notFound();
    const inner = innerParts.slice(0, i + 1).join("/");
    if (isDirectoryMode(entry.mode)) { tree = await readTree(source, project, entry.oid); continue; }
    // Symlinks and submodules are not part of the visible workspace.
    if (!isFileMode(entry.mode) || i < innerParts.length - 1) throw notFound();
    return { kind: "file", project, inner, oid: entry.oid, mode: entry.mode, time };
  }
  return { kind: "directory", project, inner: innerParts.join("/"), tree, time };
}

function entryOf(relative: string, kind: Entry["kind"], size: number, modifiedAt: string): Entry {
  const name = path.posix.basename(relative);
  return { name, path: relative, kind, extension: kind === "directory" ? "" : path.posix.extname(name).slice(1).toLowerCase(), size: kind === "directory" ? 0 : size, modifiedAt };
}

async function list(source: HubSource, at: Located, relative: string): Promise<Entry[]> {
  if (at.kind === "file") throw new MirrorError("Choose a folder, not a file.");
  if (at.kind === "space") {
    const projects = (await source.projects()).filter(project => isVisibleName(project.name));
    return projects.map(project => entryOf(join(relative, project.name), "directory", 0, project.pushedAt)).sort(compareEntries);
  }
  const visible = at.tree.filter(entry => isVisibleName(entry.name) && (isDirectoryMode(entry.mode) || isFileMode(entry.mode)));
  if (visible.length > MAX_DIRECTORY_ENTRIES) {
    throw new MirrorError(`This folder contains more than ${MAX_DIRECTORY_ENTRIES.toLocaleString("en-US")} entries. Choose a smaller workspace folder.`, 413);
  }
  const entries = await Promise.all(visible.map(async entry => isDirectoryMode(entry.mode)
    ? entryOf(join(relative, entry.name), "directory", 0, at.time)
    : entryOf(join(relative, entry.name), "file", (await source.object(at.project.fullName, entry.oid)).data.length, at.time)));
  return entries.sort(compareEntries);
}

async function blobBytes(source: HubSource, at: Extract<Located, { kind: "file" }>, limit: number): Promise<Buffer> {
  const object = await source.object(at.project.fullName, at.oid);
  if (object.data.length > limit) throw new MirrorError("This file exceeds the preview size limit.", 413);
  return Buffer.from(object.data);
}

/** The hub counterpart of loadWorkspace: the same snapshot, read from the space's git trees. */
export async function loadHubWorkspace(source: HubSource, requestedPath = "", root = ""): Promise<WorkspaceSnapshot> {
  try {
    const relative = relativePath(requestedPath);
    const base = relativePath(root);
    const at = await locate(source, join(base, relative));
    const rootAt = relative ? await locate(source, base) : at;
    if (rootAt.kind === "file") throw new MirrorError("The configured workspace must be a folder.", 400);
    const isFile = at.kind === "file";
    const directoryPath = isFile ? (path.posix.dirname(relative) === "." ? "" : path.posix.dirname(relative)) : relative;
    const rootEntries = await list(source, rootAt, "");
    const entries = directoryPath === "" ? rootEntries : await list(source, await locate(source, join(base, directoryPath)), directoryPath);
    const rootName = base ? path.posix.basename(base) : source.project || source.space;
    let file: WorkspaceSnapshot["file"];
    if (at.kind === "file") {
      const size = (await source.object(at.project.fullName, at.oid)).data.length;
      file = await buildFileView(entryOf(relative, "file", size, at.time), limit => blobBytes(source, at, limit));
    }
    return withRevision({
      rootName,
      rootId: createHash("sha256").update(`${source.id}\0${base}`).digest("hex"),
      roots: rootEntries.filter(entry => entry.kind === "directory"),
      directory: { path: directoryPath, name: directoryPath ? path.posix.basename(directoryPath) : rootName, entries },
      ...(file ? { file } : {}),
    });
  } catch (error) {
    throw safeHubError(error);
  }
}

export async function readHubPreview(source: HubSource, requestedPath: string, root = ""): Promise<PreviewResult> {
  try {
    const relative = relativePath(requestedPath);
    if (!relative) throw new MirrorError("Choose a file to preview.", 400);
    const at = await locate(source, join(relativePath(root), relative));
    if (at.kind !== "file") throw new MirrorError("Only supported images and PDF files have a binary preview.", 415);
    const contentType = previewContentType(path.posix.extname(relative).slice(1).toLowerCase());
    if (!contentType) throw new MirrorError("Only supported images and PDF files have a binary preview.", 415);
    const bytes = await blobBytes(source, at, MAX_PREVIEW_BYTES);
    if (!matchesMime(bytes, contentType)) throw new MirrorError("The file contents do not match this preview format.", 415);
    return { bytes: new Uint8Array(bytes), contentType, name: path.posix.basename(relative) };
  } catch (error) {
    throw safeHubError(error);
  }
}

/** A folder the picker may observe, as a path from the space (or project) root. */
export async function resolveHubDirectory(source: HubSource, relative: string): Promise<string> {
  try {
    const checked = relativePath(relative);
    if ((await locate(source, checked)).kind === "file") throw new MirrorError("Choose a folder, not a file.");
    return checked;
  } catch (error) {
    throw safeHubError(error);
  }
}

/** Rebuild the trees from the changed file up to the root, collecting the new objects. */
async function replaceFile(source: HubSource, project: HubProject, treeOid: string, parts: string[], blobOid: string, created: StoredObject[]): Promise<string> {
  const entries = await readTree(source, project, treeOid);
  const [name, ...rest] = parts;
  const existing = entries.find(entry => entry.name === name);
  let replacement: TreeEntry;
  if (!rest.length) {
    if (existing && !isFileMode(existing.mode)) throw new MirrorError(`${name} is not a file the chat can be saved to.`, 409);
    replacement = { mode: existing?.mode ?? FILE_MODE, name, oid: blobOid };
  } else {
    if (existing && !isDirectoryMode(existing.mode)) throw new MirrorError(`${name} is not a folder.`, 409);
    replacement = { mode: TREE_MODE, name, oid: await replaceFile(source, project, existing?.oid ?? "", rest, blobOid, created) };
  }
  const data = serializeTree([...entries.filter(entry => entry.name !== name), replacement]);
  const oid = hashObject("tree", data);
  created.push({ oid, kind: "tree", data });
  return oid;
}

async function readInner(source: HubSource, project: HubProject, treeOid: string, inner: string): Promise<TreeEntry | undefined> {
  let tree = await readTree(source, project, treeOid);
  const parts = inner.split("/");
  for (let i = 0; i < parts.length; i++) {
    const entry = tree.find(candidate => candidate.name === parts[i]);
    if (!entry || i === parts.length - 1) return entry;
    if (!isDirectoryMode(entry.mode)) return undefined;
    tree = await readTree(source, project, entry.oid);
  }
}

const RACES = 5;

/**
 * Append turns to `<conversation>.log.jsonl` as one commit on the project's
 * default branch. The hub moves the branch only if nobody pushed in between;
 * after a race the turns are appended again on top of the newer log, so
 * concurrent writers never lose each other's lines.
 */
export async function appendHubChat(source: HubSource, conversationPath: string, turns: Omit<ChatTurn, "author" | "time">[], root = ""): Promise<{ path: string; commit: string }> {
  try {
    const relative = relativePath(conversationPath);
    const logRelative = chatLogPath(relative);
    if (!logRelative) throw new MirrorError("Open a conversation's .json file to save a chat.");
    const author = await source.author();
    if (!author) throw new MirrorError("Saving chats needs a spacehub sign-in: run spacehub auth login (or set SPACEHUB_TOKEN), then restart open-chat.", 401);
    const now = new Date();
    const lines = turns.map(turn => chatLogLine({ ...turn, author: turn.role === "user" ? author : "quirqy", time: now.toISOString() })).join("");
    for (let attempt = 1; ; attempt++) {
      const at = await locate(source, join(relativePath(root), relative));
      if (at.kind !== "file") throw new MirrorError("Open a conversation's .json file to save a chat.");
      let data: unknown;
      try { data = JSON.parse(Buffer.from((await source.object(at.project.fullName, at.oid)).data).toString("utf8")); } catch { data = undefined; }
      if (!isConversation(data)) throw new MirrorError("Only conversation files can take new messages.");
      const { head, tree } = await rootTree(source, at.project);
      const logInner = chatLogPath(at.inner)!;
      const existing = await readInner(source, at.project, tree, logInner);
      if (existing && !isFileMode(existing.mode)) throw new MirrorError(`${logInner} is not a file the chat can be saved to.`, 409);
      const before = existing ? Buffer.from((await source.object(at.project.fullName, existing.oid)).data).toString("utf8") : "";
      const content = before + (before && !before.endsWith("\n") ? "\n" : "") + lines;
      if (Buffer.byteLength(content) > MAX_TEXT_BYTES) throw new MirrorError("This chat log reached the 2 MB limit. Start a new conversation file.", 413);
      const blob = Buffer.from(content, "utf8");
      const blobOid = hashObject("blob", blob);
      const created: StoredObject[] = [{ oid: blobOid, kind: "blob", data: blob }];
      const newTree = await replaceFile(source, at.project, tree, logInner.split("/"), blobOid, created);
      const commit = serializeCommit({
        tree: newTree,
        parents: head ? [head] : [],
        author: { name: author, email: `${author}@${source.host.replace(/:\d+$/, "")}`, when: now.getTime() / 1000 },
        message: `chat: ${turns.length === 1 ? "1 message" : `${turns.length} messages`} in ${logInner}\n\nSaved by open-chat.`,
      });
      const commitOid = hashObject("commit", commit);
      created.push({ oid: commitOid, kind: "commit", data: commit });
      try {
        await source.push(at.project.fullName, created, at.project.defaultBranch, head, commitOid);
        return { path: logRelative, commit: commitOid };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt < RACES && /stale info|non-fast-forward/i.test(message)) continue;
        if (/permission denied/i.test(message)) throw new MirrorError(`The hub refused the chat: ${message}`, 403);
        throw error;
      }
    }
  } catch (error) {
    throw safeHubError(error);
  }
}
