import { MirrorError } from "./filesystem";
import { HubConfigError, hubConfig } from "./hub/config";
import { spacetimeHub } from "./hub/spacetime";
import type { HubSource } from "./hub/workspace";

const OVERRIDE = Symbol.for("open-chat.hub-source-override");
type Holder = Record<symbol, HubSource | null | undefined>;

/** Tests swap in an in-memory hub (or null for the file-system backend); undefined restores the environment's choice. */
export function setHubSourceForTests(source: HubSource | null | undefined): void {
  (globalThis as Holder)[OVERRIDE] = source;
}

/** The hub backend when SPACEHUB_SPACE is set; undefined means the file-system backend. */
export function hubSource(): HubSource | undefined {
  const override = (globalThis as Holder)[OVERRIDE];
  if (override !== undefined) return override ?? undefined;
  try {
    const config = hubConfig();
    return config ? spacetimeHub(config) : undefined;
  } catch (error) {
    if (error instanceof HubConfigError) throw new MirrorError(error.message, 500);
    throw error;
  }
}
