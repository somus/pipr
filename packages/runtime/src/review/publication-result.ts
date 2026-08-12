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
