import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_SERVER = "wss://hub.quirq.dev";
export const DEFAULT_DATABASE = "spacehub";

/** Where the hub backend reads and writes. Only the server process sees the token. */
export interface HubConfig {
  server: string;
  database: string;
  token?: string;
  /** The space whose projects become the workspace. */
  space: string;
  /** Set when SPACEHUB_SPACE names one project: that project's files are the workspace. */
  project?: string;
}

const SPACE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const PROJECT = /^[A-Za-z0-9_.-]{1,100}$/;

export class HubConfigError extends Error {}
type Env = Record<string, string | undefined>;

/** The http(s) form of a hub address is accepted too; the SDK speaks websockets. */
export function normalizeServer(url: string): string {
  return url.trim().replace(/^http:/, "ws:").replace(/^https:/, "wss:").replace(/\/+$/, "");
}

/** The token `spacehub auth login` saved for this server, if any. */
function savedToken(server: string, env: Env): string | undefined {
  const file = path.join(env.SPACEHUB_HOME || path.join(os.homedir(), ".spacehub"), "config.json");
  try {
    const tokens = (JSON.parse(readFileSync(file, "utf8")) as { tokens?: Record<string, unknown> }).tokens;
    const token = tokens?.[server];
    return typeof token === "string" && token ? token : undefined;
  } catch {
    return undefined;
  }
}

/** The hub backend's settings, or undefined when SPACEHUB_SPACE is unset (the file-system backend). */
export function hubConfig(env: Env = process.env): HubConfig | undefined {
  const target = env.SPACEHUB_SPACE?.trim();
  if (!target) return undefined;
  const [space, project, extra] = target.split("/");
  if (extra !== undefined || !SPACE.test(space.toLowerCase()) || (project !== undefined && !PROJECT.test(project))) {
    throw new HubConfigError("SPACEHUB_SPACE must be a space, like quirq, or one project, like quirq/quirq.");
  }
  const server = normalizeServer(env.SPACEHUB_SERVER || DEFAULT_SERVER);
  if (!/^wss?:\/\/[^/\s]+$/.test(server)) throw new HubConfigError("SPACEHUB_SERVER must be a hub address, like wss://hub.quirq.dev.");
  return {
    server,
    database: env.SPACEHUB_DB?.trim() || DEFAULT_DATABASE,
    token: env.SPACEHUB_TOKEN?.trim() || savedToken(server, env),
    space: space.toLowerCase(),
    ...(project !== undefined ? { project } : {}),
  };
}

export function hubHost(config: HubConfig): string {
  return config.server.replace(/^wss?:\/\//, "");
}

export function hubTarget(config: HubConfig): string {
  return config.project ? `${config.space}/${config.project}` : config.space;
}
