import type { RunRecord } from "./archive.js";

export class PartialRunArchiveListError extends Error {
  constructor(
    message: string,
    readonly records: RunRecord[],
  ) {
    super(message);
  }
}
