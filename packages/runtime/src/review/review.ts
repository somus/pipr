import type { ValidatedReviewFindings } from "@usepipr/sdk";
import { diffFileMatchesPathFilter, pathMatchesFilter } from "../diff/path-filter.js";
import { createDiffRangeIndex } from "../diff/ranges.js";
import type {
  CommentableRange,
  DiffManifest,
  DiffManifestFile,
  PathFilter,
  ValidatedReview,
} from "../types.js";
import { parseValidatedReview } from "../types.js";
import type { ReviewFinding, ReviewResult } from "./contract.js";
import { findingContentHash } from "./prior-state.js";
import { type FindingDropReason, findingRangeMismatch } from "./range-validation.js";

export type ValidateReviewOptions = {
  expectedHeadSha?: string;
  pathScopeForFinding?: (finding: ReviewFinding, index: number) => PathFilter | undefined;
};

export function validateReviewResult(
  review: ReviewResult,
  manifest: DiffManifest,
  options: ValidateReviewOptions,
): ValidatedReview {
  const findings = validateReviewFindings(review.inlineFindings, manifest, options);
  return parseValidatedReview({
    review,
    validFindings: findings.validFindings,
    droppedFindings: findings.droppedFindings,
  });
}

export function validateReviewFindings<T extends ReviewFinding>(
  findings: readonly T[],
  manifest: DiffManifest,
  options: ValidateReviewOptions,
): ValidatedReviewFindings<T> {
  if (options.expectedHeadSha && manifest.headSha !== options.expectedHeadSha) {
    throw new Error(
      `Diff Manifest head SHA '${manifest.headSha}' does not match expected head SHA '${options.expectedHeadSha}'`,
    );
  }
  const ranges = createDiffRangeIndex(manifest);
  const seenFingerprints = new Set<string>();
  const validFindings: ValidatedReviewFindings<T>["validFindings"][number][] = [];
  const droppedFindings: ValidatedReviewFindings<T>["droppedFindings"][number][] = [];

  for (const [index, finding] of findings.entries()) {
    const suppliedRange = ranges.findRange(finding.rangeId)?.range;
    const validatedFinding = findingRangeMismatch(finding, suppliedRange)
      ? canonicalizeFindingRangeId(finding, manifest)
      : findingWithRangeId(finding, finding.rangeId);
    const fingerprint = findingContentHash(validatedFinding);
    const rangeMatch = ranges.findRange(validatedFinding.rangeId);
    const drop = findingDropReason({
      finding: validatedFinding,
      fingerprint,
      pathScope: options.pathScopeForFinding?.(validatedFinding, index),
      file: rangeMatch?.file,
      range: rangeMatch?.range,
      excludedReason: ranges.excludedReason(validatedFinding.path),
      seenFingerprints,
    });

    if (drop) {
      droppedFindings.push({ finding: validatedFinding, code: drop.code, reason: drop.message });
      continue;
    }

    seenFingerprints.add(fingerprint);
    validFindings.push(validatedFinding);
  }

  return { validFindings, droppedFindings };
}

function canonicalizeFindingRangeId<T extends ReviewFinding>(
  finding: T,
  manifest: DiffManifest,
): ValidatedReviewFindings<T>["validFindings"][number] {
  if (finding.startLine > finding.endLine) {
    return findingWithRangeId(finding, finding.rangeId);
  }

  const matchingRanges = manifest.files.flatMap((file) =>
    file.commentableRanges.filter(
      (range) =>
        range.path === finding.path &&
        range.side === finding.side &&
        finding.startLine >= range.startLine &&
        finding.endLine <= range.endLine,
    ),
  );
  const matchingRange = matchingRanges.length === 1 ? matchingRanges[0] : undefined;
  return findingWithRangeId(finding, matchingRange?.id ?? finding.rangeId);
}

function findingWithRangeId<T extends ReviewFinding>(
  finding: T,
  rangeId: string,
): ValidatedReviewFindings<T>["validFindings"][number] {
  return { ...finding, rangeId } as ValidatedReviewFindings<T>["validFindings"][number];
}

type FindingValidationContext = {
  finding: ReviewFinding;
  fingerprint: string;
  pathScope?: PathFilter;
  file?: DiffManifestFile;
  range?: CommentableRange;
  excludedReason?: string;
  seenFingerprints: Set<string>;
};

type FindingValidator = (context: FindingValidationContext) => FindingDropReason | undefined;

const findingValidators: FindingValidator[] = [
  validatePathScope,
  validateExcludedFile,
  (context) => findingRangeMismatch(context.finding, context.range),
  validateDuplicateFingerprint,
];

function findingDropReason(context: FindingValidationContext): FindingDropReason | undefined {
  for (const validator of findingValidators) {
    const drop = validator(context);
    if (drop) {
      return drop;
    }
  }
  return undefined;
}

function validatePathScope(context: FindingValidationContext): FindingDropReason | undefined {
  if (!context.pathScope) {
    return undefined;
  }
  const matches =
    context.file && context.finding.path === context.file.path
      ? diffFileMatchesPathFilter(context.file, context.pathScope)
      : pathMatchesFilter(context.finding.path, context.pathScope);
  return matches
    ? undefined
    : { code: "path-scope", message: "finding path is outside configured paths" };
}

function validateExcludedFile(context: FindingValidationContext): FindingDropReason | undefined {
  return context.excludedReason
    ? {
        code: "excluded-file",
        message: `file excluded from inline comments: ${context.excludedReason}`,
      }
    : undefined;
}

function validateDuplicateFingerprint(
  context: FindingValidationContext,
): FindingDropReason | undefined {
  return context.seenFingerprints.has(context.fingerprint)
    ? { code: "duplicate", message: "duplicate finding fingerprint" }
    : undefined;
}
