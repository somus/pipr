import type { PublicationMetadata } from "./comment.js";

export type PublicationResult = {
  mainComment: {
    action: "created" | "updated";
    id: number;
  };
  inlineComments: {
    posted: number;
    skipped: number;
    failed: number;
  };
  metadata: PublicationMetadata & {
    inlinePublicationErrors: string[];
    inlineResolutionErrors: string[];
  };
};

/** Error thrown when publication fails after producing partial result metadata. */
export class PublicationError extends Error {
  constructor(
    message: string,
    readonly result: Omit<PublicationResult, "mainComment"> | undefined,
  ) {
    super(message);
  }
}
