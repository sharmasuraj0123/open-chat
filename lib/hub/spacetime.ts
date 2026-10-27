import type { Identity, RowTypedQuery } from "spacetimedb";
import { DbConnection, tables } from "./module_bindings";
import { hubHost, type HubConfig } from "./config";
import type { GitObject } from "./git";
import type { HubProject, HubSource, StoredObject } from "./workspace";

// Must match the spacehub module: bodies over one chunk go through putChunk.
const CHUNK_SIZE = 1024 * 1024;
const FETCH_WINDOW = 8n * 1024n * 1024n;
const BATCH_BYTES = 4 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 15_000;
const RETRY_AFTER_MS = 5_000;

export type HubState = "connecting" | "live" | "reconnecting" | "offline";

interface Session {
  conn: DbConnection;
  identity: Identity;
  /** Applied once the space's projects (or the one project) are in the client cache. */
  ready: Promise<void>;
}

/** Subscribe, read the rows once they arrive, then drop the subscription. */
function snapshot<T>(conn: DbConnection, query: RowTypedQuery<any, any>, read: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    const handle = conn.subscriptionBuilder()
      .onApplied(() => {
        let value: T;
        try { value = read(); } catch (error) { reject(error); return; }
        handle.unsubscribeThen(() => resolve(value));
      })
      .onError(ctx => reject(new Error(`query failed: ${String((ctx as { event?: unknown }).event ?? "unknown error")}`)))
      .subscribe(query);
  });
}

function subscribe(conn: DbConnection, query: RowTypedQuery<any, any>): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.subscriptionBuilder()
      .onApplied(() => resolve())
      .onError(ctx => reject(new Error(`subscription failed: ${String((ctx as { event?: unknown }).event ?? "unknown error")}`)))
      .subscribe(query);
  });
}

/**
 * A live view of one space on a spacehub server. Project and ref rows stay
 * subscribed, so pushes from other devices and agents arrive on their own;
 * git objects are downloaded from each project's object log as it grows and
 * kept in memory (objects never change, so the cache never goes stale).
 */
export class SpacetimeHub implements HubSource {
  readonly id: string;
  readonly host: string;
  readonly space: string;
  readonly project?: string;
  state: HubState = "connecting";
  lastError = "";
  private session?: Promise<Session>;
  private failedAt = 0;
  private readonly refsFollowed = new Map<bigint, Promise<void>>();
  private readonly objects = new Map<string, GitObject>();
  private readonly loadedPos = new Map<bigint, bigint>();
  private readonly loading = new Map<bigint, Promise<void>>();

  constructor(private readonly config: HubConfig) {
    this.id = `${config.server}/${config.database}/${config.space}${config.project ? "/" + config.project : ""}`;
    this.host = hubHost(config);
    this.space = config.space;
    this.project = config.project;
  }

  private connect(): Promise<Session> {
    if (this.session) return this.session;
    if (Date.now() - this.failedAt < RETRY_AFTER_MS) return Promise.reject(new Error(this.lastError || "the hub is unreachable"));
    this.state = "connecting";
    const session = new Promise<Session>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.lastError = `timed out connecting to ${this.config.server}`;
        reject(new Error(this.lastError));
        attempt.disconnect();
      }, CONNECT_TIMEOUT_MS);
      const attempt = DbConnection.builder()
        .withUri(this.config.server)
        .withDatabaseName(this.config.database)
        .withToken(this.config.token)
        .withAutomaticReconnect()
        .onConnect((conn, identity) => {
          clearTimeout(timer);
          this.state = "live";
          this.lastError = "";
          const scope = this.project
            ? tables.project.where(row => row.fullName.eq(`${this.space}/${this.project}`))
            : tables.project.where(row => row.owner.eq(this.space));
          // Who this token is: a builder, or an agent pushing on its own.
          const ready = Promise.all([subscribe(conn, scope), subscribe(conn, tables.user.where(row => row.identity.eq(identity))), subscribe(conn, tables.agent)]).then(() => undefined);
          resolve({ conn, identity, ready });
        })
        .onAutomaticReconnect(() => { this.state = "live"; this.lastError = ""; })
        .onDisconnect((_ctx, error, nextAttempt) => {
          this.state = nextAttempt === undefined ? "offline" : "reconnecting";
          this.lastError = error?.message ?? "disconnected from the hub";
          if (nextAttempt === undefined) this.reset();
        })
        .onConnectError((_ctx, error, nextAttempt) => {
          clearTimeout(timer);
          this.lastError = `cannot connect to ${this.config.server}: ${error?.message ?? error}`;
          if (nextAttempt === undefined) { this.state = "offline"; reject(new Error(this.lastError)); }
          else this.state = "reconnecting";
        })
        .build();
    });
    this.session = session;
    session.catch(() => { this.failedAt = Date.now(); this.reset(); });
    return session;
  }

  status() {
    return { state: this.state, error: this.lastError };
  }

  /** Close the connection; the next read connects again. */
  async close(): Promise<void> {
    const session = this.session;
    this.reset();
    const open = await session?.catch(() => undefined);
    open?.conn.disconnect();
  }

  private reset() {
    this.session = undefined;
    this.refsFollowed.clear();
  }

  private async ready(): Promise<Session> {
    const session = await this.connect();
    await session.ready;
    return session;
  }

  async projects(): Promise<HubProject[]> {
    const { conn } = await this.ready();
    return [...conn.db.project.iter()]
      .filter(row => this.project ? row.fullName === `${this.space}/${this.project}` : row.owner === this.space)
      .map(row => ({ name: row.name, fullName: row.fullName, defaultBranch: row.defaultBranch, pushedAt: row.pushedAt.toDate().toISOString() }));
  }

  private async row(fullName: string) {
    const { conn } = await this.ready();
    const row = [...conn.db.project.iter()].find(candidate => candidate.fullName === fullName);
    if (!row) throw new Error(`project ${fullName} is not in ${this.space}`);
    return { conn, row };
  }

  async head(fullName: string): Promise<string> {
    const { conn, row } = await this.row(fullName);
    let followed = this.refsFollowed.get(row.id);
    if (!followed) {
      followed = subscribe(conn, tables.gitRef.where(ref => ref.projectId.eq(row.id)));
      followed.catch(() => this.refsFollowed.delete(row.id));
      this.refsFollowed.set(row.id, followed);
    }
    await followed;
    const name = `refs/heads/${row.defaultBranch}`;
    return [...conn.db.gitRef.iter()].find(ref => ref.projectId === row.id && ref.name === name)?.oid ?? "";
  }

  /** Download what the project's object log gained since the last read. */
  private async catchUp(fullName: string): Promise<bigint> {
    const { conn, row } = await this.row(fullName);
    const id = row.id;
    while ((this.loadedPos.get(id) ?? 0n) < row.objectPos) {
      const running = this.loading.get(id);
      if (running) { await running; continue; }
      const from = this.loadedPos.get(id) ?? 0n;
      const to = row.objectPos;
      const task = (async () => {
        for (let low = from; low < to; low += FETCH_WINDOW) {
          const high = low + FETCH_WINDOW;
          const rows = await snapshot(conn, tables.gitObject.where(r => r.projectId.eq(id).and(r.pos.gt(low)).and(r.pos.lte(high))),
            () => [...conn.db.gitObject.iter()].filter(r => r.projectId === id && r.pos > low && r.pos <= high));
          for (const object of rows) {
            const data = object.chunks === 0 ? object.data : await this.chunked(conn, id, object.oid, Number(object.size), object.chunks);
            this.objects.set(`${id}:${object.oid}`, { kind: object.kind as GitObject["kind"], data });
          }
        }
        this.loadedPos.set(id, to);
      })();
      this.loading.set(id, task);
      try { await task; } finally { this.loading.delete(id); }
    }
    return id;
  }

  private async chunked(conn: DbConnection, projectId: bigint, oid: string, size: number, chunks: number): Promise<Uint8Array> {
    const body = new Uint8Array(size);
    await snapshot(conn, tables.objectChunk.where(r => r.projectId.eq(projectId).and(r.oid.eq(oid))), () => {
      for (const chunk of conn.db.objectChunk.iter()) {
        if (chunk.projectId === projectId && chunk.oid === oid && chunk.idx < chunks) body.set(chunk.data, chunk.idx * CHUNK_SIZE);
      }
    });
    return body;
  }

  async object(fullName: string, oid: string): Promise<GitObject> {
    const { row } = await this.row(fullName);
    const cached = this.objects.get(`${row.id}:${oid}`);
    if (cached) return cached;
    const id = await this.catchUp(fullName);
    const object = this.objects.get(`${id}:${oid}`);
    if (!object) throw new Error(`the hub has no object ${oid} in ${fullName}`);
    return object;
  }

  async push(fullName: string, objects: StoredObject[], branch: string, oldOid: string, newOid: string): Promise<void> {
    const { conn, row } = await this.row(fullName);
    let batch: { oid: string; kind: string; data: Uint8Array }[] = [];
    let bytes = 0;
    const flush = async () => {
      if (batch.length) await conn.reducers.putObjects({ project: fullName, objects: batch });
      batch = [];
      bytes = 0;
    };
    for (const object of objects) {
      if (object.data.length > CHUNK_SIZE) {
        const chunks = Math.ceil(object.data.length / CHUNK_SIZE);
        for (let idx = 0; idx < chunks; idx++) {
          await conn.reducers.putChunk({ project: fullName, oid: object.oid, idx, data: object.data.subarray(idx * CHUNK_SIZE, (idx + 1) * CHUNK_SIZE) });
        }
        await conn.reducers.finishObject({ project: fullName, oid: object.oid, kind: object.kind, size: BigInt(object.data.length), chunks });
        continue;
      }
      batch.push({ oid: object.oid, kind: object.kind, data: object.data });
      bytes += object.data.length;
      if (bytes >= BATCH_BYTES) await flush();
    }
    await flush();
    await conn.reducers.updateRef({ project: fullName, name: `refs/heads/${branch}`, oldOid, newOid, force: false });
    // The objects are ours already; later reads need not wait for the download.
    for (const object of objects) this.objects.set(`${row.id}:${object.oid}`, { kind: object.kind, data: object.data });
  }

  async author(): Promise<string | undefined> {
    const { conn, identity } = await this.ready();
    return [...conn.db.user.iter()].find(row => row.identity.isEqual(identity))?.username
      ?? [...conn.db.agent.iter()].find(row => row.identity.isEqual(identity))?.name;
  }
}

const HUBS = Symbol.for("open-chat.hubs");
type Registry = Map<string, SpacetimeHub>;

/** One connection per hub, space and token for the whole server process (and across dev reloads). */
export function spacetimeHub(config: HubConfig): SpacetimeHub {
  const registry = ((globalThis as Record<symbol, Registry | undefined>)[HUBS] ??= new Map());
  const key = JSON.stringify(config);
  let hub = registry.get(key);
  if (!hub) { hub = new SpacetimeHub(config); registry.set(key, hub); }
  return hub;
}
