import type { DroppedReviewFinding, FindingFacets, ReviewFinding } from "@usepipr/sdk";

export type FindingSelectionOptions<T extends ReviewFinding> = {
  facets?: FindingFacets;
  rank?: readonly string[];
  compare?: (left: T, right: T) => number;
  limit?: number;
};

export type FindingSelection<T extends ReviewFinding> = {
  findings: T[];
  dropped: DroppedReviewFinding<T>[];
};

export const capDropReason = "cap";

/**
 * Ranks validated findings by facet declaration order (or a custom comparator) and caps the
 * result. Input order breaks ties.
 */
export function selectRankedFindings<T extends ReviewFinding>(
  findings: readonly T[],
  options: FindingSelectionOptions<T>,
): FindingSelection<T> {
  const compare = options.compare ?? facetComparator<T>(options.facets ?? {}, options.rank);
  const ranked = findings
    .map((finding, index) => ({ finding, index }))
    .toSorted((left, right) => compare(left.finding, right.finding) || left.index - right.index)
    .map((entry) => entry.finding);
  const limit = options.limit ?? ranked.length;
  return {
    findings: ranked.slice(0, limit),
    dropped: ranked
      .slice(limit)
      .map((finding) => ({ finding, reason: capDropReason }) as DroppedReviewFinding<T>),
  };
}

/** Returns facet values present on a finding, limited to declared facet keys and values. */
export function findingFacetValues(
  finding: ReviewFinding,
  facets: FindingFacets,
): Record<string, string> {
  const values: Record<string, string> = {};
  const record = finding as Record<string, unknown>;
  for (const [key, allowed] of Object.entries(facets)) {
    const value = record[key];
    if (typeof value === "string" && allowed.includes(value)) {
      values[key] = value;
    }
  }
  return values;
}

function facetComparator<T extends ReviewFinding>(
  facets: FindingFacets,
  rank: readonly string[] | undefined,
): (left: T, right: T) => number {
  const keys = rank ?? Object.keys(facets);
  for (const key of keys) {
    if (!facets[key]) {
      throw new Error(`ctx.review.select rank key '${key}' is not an enum field of the finding`);
    }
  }
  return (left, right) => {
    for (const key of keys) {
      const order = facets[key] ?? [];
      const difference =
        facetRank(order, (left as Record<string, unknown>)[key]) -
        facetRank(order, (right as Record<string, unknown>)[key]);
      if (difference !== 0) {
        return difference;
      }
    }
    return 0;
  };
}

function facetRank(order: readonly string[], value: unknown): number {
  const index = typeof value === "string" ? order.indexOf(value) : -1;
  return index === -1 ? order.length : index;
}
