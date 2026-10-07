import type { PublicationResult } from "../publication/types.js";

/** Error thrown when publication fails after producing partial result metadata. */
export class PublicationError extends Error {
  constructor(
    message: string,
    readonly result: Omit<PublicationResult, "mainComment"> | undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type StaleEndpoint = {
  provider: string;
  endpoint: "head" | "base";
  expectedSha: string;
  currentSha: string;
  /** Write the check guarded; defaults to `publication`. */
  stage?: string;
};

/** The change request head or base moved away from the reviewed commits before a write. */
export class StaleHeadError extends PublicationError {
  readonly provider: string;
  readonly endpoint: "head" | "base";
  readonly expectedSha: string;
  readonly currentSha: string;

  constructor(stale: StaleEndpoint) {
    super(
      `${stale.provider} change request ${stale.endpoint} changed from '${stale.expectedSha}' to '${stale.currentSha}' before ${stale.stage ?? "publication"}`,
      undefined,
    );
    this.name = "StaleHeadError";
    this.provider = stale.provider;
    this.endpoint = stale.endpoint;
    this.expectedSha = stale.expectedSha;
    this.currentSha = stale.currentSha;
  }
}
