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
import {
  parseReviewResult,
  type ReviewFinding,
  type ReviewResult,
  reviewResultJsonSchema,
  reviewResultSchemaId,
  reviewSchemaExample,
} from "./contract.js";
import { findingRangeMismatchReason } from "./range-validation.js";

export { parseReviewResult, reviewResultJsonSchema, reviewResultSchemaId, reviewSchemaExample };

export type ValidateReviewOptions = {
  expectedHeadSha?: string;
  pathScopeForFinding?: (finding: ReviewFinding, index: number) => PathFilter | undefined;
};

export function validateReviewResult(
  review: ReviewResult,
  manifest: DiffManifest,
  options: ValidateReviewOptions,
): ValidatedReview {
  if (options.expectedHeadSha && manifest.headSha !== options.expectedHeadSha) {
    throw new Error(
      `Diff Manifest head SHA '${manifest.headSha}' does not match expected head SHA '${options.expectedHeadSha}'`,
    );
  }
  const ranges = createDiffRangeIndex(manifest);
  const seenFingerprints = new Set<string>();

  const validFindings: ReviewFinding[] = [];
  const droppedFindings: ValidatedReview["droppedFindings"] = [];

  for (const [index, finding] of review.inlineFindings.entries()) {
    const suppliedRange = ranges.findRange(finding.rangeId)?.range;
    const validatedFinding = findingRangeMismatchReason(finding, suppliedRange)
      ? canonicalizeFindingRangeId(finding, manifest)
      : finding;
    const fingerprint = findingFingerprint(validatedFinding);
    const rangeMatch = ranges.findRange(validatedFinding.rangeId);
    const reason = findingDropReason({
      finding: validatedFinding,
      fingerprint,
      pathScope: options.pathScopeForFinding?.(validatedFinding, index),
      file: rangeMatch?.file,
      range: rangeMatch?.range,
      excludedReason: ranges.excludedReason(validatedFinding.path),
      seenFingerprints,
    });

    if (reason) {
      droppedFindings.push({ finding, reason });
      continue;
    }

    seenFingerprints.add(fingerprint);
    validFindings.push(validatedFinding);
  }

  return parseValidatedReview({
    review,
    validFindings,
    droppedFindings,
  });
}

function canonicalizeFindingRangeId(finding: ReviewFinding, manifest: DiffManifest): ReviewFinding {
  if (finding.startLine > finding.endLine) {
    return finding;
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
  return matchingRange ? { ...finding, rangeId: matchingRange.id } : finding;
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

type FindingValidator = (context: FindingValidationContext) => string | undefined;

const findingValidators: FindingValidator[] = [
  validatePathScope,
  validateExcludedFile,
  (context) => findingRangeMismatchReason(context.finding, context.range),
  validateDuplicateFingerprint,
];

function findingDropReason(context: FindingValidationContext): string | undefined {
  for (const validator of findingValidators) {
    const reason = validator(context);
    if (reason) {
      return reason;
    }
  }
  return undefined;
}

function validatePathScope(context: FindingValidationContext): string | undefined {
  if (!context.pathScope) {
    return undefined;
  }
  const matches =
    context.file && context.finding.path === context.file.path
      ? diffFileMatchesPathFilter(context.file, context.pathScope)
      : pathMatchesFilter(context.finding.path, context.pathScope);
  return matches ? undefined : "finding path is outside configured paths";
}

function validateExcludedFile(context: FindingValidationContext): string | undefined {
  return context.excludedReason
    ? `file excluded from inline comments: ${context.excludedReason}`
    : undefined;
}

function validateDuplicateFingerprint(context: FindingValidationContext): string | undefined {
  return context.seenFingerprints.has(context.fingerprint)
    ? "duplicate finding fingerprint"
    : undefined;
}

function findingFingerprint(finding: ReviewFinding): string {
  const location = [
    finding.path,
    finding.rangeId,
    finding.side,
    `${finding.startLine}-${finding.endLine}`,
  ];
  const basis = [...location, finding.body].join("\n");
  return new Bun.CryptoHasher("sha256").update(basis).digest("hex").slice(0, 16);
}
