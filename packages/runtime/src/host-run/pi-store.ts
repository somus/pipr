import path from "node:path";
import type { ChangeRequestEventContext } from "../types.js";

export function changeRequestPiStoreDir(
  root: string | undefined,
  event: ChangeRequestEventContext,
): string | undefined {
  if (!root) return undefined;
  return path.join(
    root,
    storeSegment(event.platform.id),
    storeSegment(event.repository.slug),
    String(event.change.number),
  );
}

function storeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "__");
}
