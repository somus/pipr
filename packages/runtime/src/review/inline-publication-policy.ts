export type InlinePublicationLocation = {
  path: string;
  commitId: string;
  side: "RIGHT" | "LEFT";
  startLine: number;
  endLine: number;
};

export type InlinePublicationPolicyState = {
  markers: Set<string>;
  locations: InlinePublicationLocation[];
};

export function inlinePublicationDecision(options: {
  marker: string;
  location: InlinePublicationLocation;
  existing: InlinePublicationPolicyState;
}): "post" | "skip" {
  if (
    options.existing.markers.has(options.marker) ||
    hasExistingInlinePublicationLocation(options.existing.locations, options.location)
  ) {
    return "skip";
  }
  return "post";
}

function hasExistingInlinePublicationLocation(
  existing: InlinePublicationLocation[],
  location: InlinePublicationLocation,
): boolean {
  return existing.some((comment) => {
    if (
      comment.path !== location.path ||
      comment.commitId !== location.commitId ||
      comment.side !== location.side
    ) {
      return false;
    }
    return comment.startLine <= location.endLine && location.startLine <= comment.endLine;
  });
}
