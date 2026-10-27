import { FILE_MODE, TREE_MODE, hashObject, serializeCommit, serializeTree, type GitObject, type TreeEntry } from "../../lib/hub/git";
import type { HubProject, HubSource, StoredObject } from "../../lib/hub/workspace";

export type Files = Record<string, string | Uint8Array | { symlink: string }>;

/** An in-memory hub with spacehub's push rule: a branch moves only from the value the pusher saw. */
export class MemoryHub implements HubSource {
  readonly id: string;
  readonly host = "hub.test";
  readonly objects = new Map<string, GitObject>();
  readonly heads = new Map<string, string>();
  readonly pushes: { fullName: string; oldOid: string; newOid: string }[] = [];
  private readonly list: HubProject[] = [];
  user: string | undefined = "suraj";
  /** Runs before a push lands, to stage a competing push. */
  beforePush?: (fullName: string) => void | Promise<void>;
  refuse?: string;
  private clock = 1_800_000_000;

  constructor(readonly space: string, readonly project?: string) {
    this.id = `memory/${space}/${project ?? ""}`;
  }

  store(kind: GitObject["kind"], data: Uint8Array): string {
    const oid = hashObject(kind, data);
    this.objects.set(oid, { kind, data });
    return oid;
  }

  private tree(files: Files): string {
    const folders = new Map<string, Files>();
    const entries: TreeEntry[] = [];
    for (const [name, content] of Object.entries(files)) {
      const [head, ...rest] = name.split("/");
      if (rest.length) { folders.set(head, { ...folders.get(head), [rest.join("/")]: content }); continue; }
      if (typeof content === "object" && "symlink" in content) entries.push({ mode: "120000", name, oid: this.store("blob", Buffer.from(content.symlink)) });
      else entries.push({ mode: FILE_MODE, name, oid: this.store("blob", typeof content === "string" ? Buffer.from(content) : content) });
    }
    for (const [name, inner] of folders) entries.push({ mode: TREE_MODE, name, oid: this.tree(inner) });
    return this.store("tree", serializeTree(entries));
  }

  /** Commit `files` as the new state of a project's default branch. */
  commit(name: string, files: Files, message = "update"): string {
    const fullName = `${this.space}/${name}`;
    if (!this.list.some(project => project.fullName === fullName)) this.list.push({ name, fullName, defaultBranch: "main", pushedAt: new Date(0).toISOString() });
    const parent = this.heads.get(fullName);
    const oid = this.store("commit", serializeCommit({ tree: this.tree(files), parents: parent ? [parent] : [], author: { name: "seed", email: "seed@hub.test", when: this.clock++ }, message }));
    this.heads.set(fullName, oid);
    return oid;
  }

  async projects() { return this.list.filter(project => !this.project || project.fullName === `${this.space}/${this.project}`); }
  async head(fullName: string) { return this.heads.get(fullName) ?? ""; }
  async object(_fullName: string, oid: string) {
    const object = this.objects.get(oid);
    if (!object) throw new Error(`missing ${oid}`);
    return object;
  }
  async push(fullName: string, objects: StoredObject[], _branch: string, oldOid: string, newOid: string) {
    if (this.refuse) throw new Error(this.refuse);
    await this.beforePush?.(fullName);
    for (const object of objects) {
      if (hashObject(object.kind, object.data) !== object.oid) throw new Error(`object ${object.oid} hashes differently`);
      this.objects.set(object.oid, { kind: object.kind, data: object.data });
    }
    const current = this.heads.get(fullName) ?? "";
    if (current !== oldOid) throw new Error(`stale info: refs/heads/main is at ${current}, fetch first`);
    this.heads.set(fullName, newOid);
    this.pushes.push({ fullName, oldOid, newOid });
  }
  async author() { return this.user; }
}
