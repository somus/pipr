import { bugHunterRecipe } from "./recipes/bug-hunter.js";
import { changelogDraftRecipe } from "./recipes/changelog-draft.js";
import { ciTriageCommandRecipe } from "./recipes/ci-triage-command.js";
import { defaultReviewRecipe } from "./recipes/default-review.js";
import { dependencyRiskRecipe } from "./recipes/dependency-risk.js";
import { diffDiagnosticsRecipe } from "./recipes/diff-diagnostics.js";
import { interactiveAskRecipe } from "./recipes/interactive-ask.js";
import { multiAgentReviewRecipe } from "./recipes/multi-agent-review.js";
import { pluginToolReviewRecipe } from "./recipes/plugin-tool-review.js";
import { prBriefingRecipe } from "./recipes/pr-briefing.js";
import { prHygieneRecipe } from "./recipes/pr-hygiene.js";
import { qualityGateRecipe } from "./recipes/quality-gate.js";
import { securitySastRecipe } from "./recipes/security-sast.js";
import type {
  OfficialInitRecipe,
  OfficialInitRecipeFile,
  OfficialInitRecipeWorkflowEnvSecret,
} from "./recipes/types.js";

export const supportedOfficialInitRecipes = [
  "default-review",
  "bug-hunter",
  "security-sast",
  "quality-gate",
  "diff-diagnostics",
  "pr-hygiene",
  "dependency-risk",
  "ci-triage-command",
  "multi-agent-review",
  "plugin-tool-review",
  "pr-briefing",
  "interactive-ask",
  "changelog-draft",
] as const;

export type OfficialInitRecipeId = (typeof supportedOfficialInitRecipes)[number];
export type { OfficialInitRecipe, OfficialInitRecipeFile, OfficialInitRecipeWorkflowEnvSecret };

const officialInitRecipeRegistry = {
  "default-review": defaultReviewRecipe,
  "bug-hunter": bugHunterRecipe,
  "security-sast": securitySastRecipe,
  "quality-gate": qualityGateRecipe,
  "diff-diagnostics": diffDiagnosticsRecipe,
  "pr-hygiene": prHygieneRecipe,
  "dependency-risk": dependencyRiskRecipe,
  "ci-triage-command": ciTriageCommandRecipe,
  "multi-agent-review": multiAgentReviewRecipe,
  "plugin-tool-review": pluginToolReviewRecipe,
  "pr-briefing": prBriefingRecipe,
  "interactive-ask": interactiveAskRecipe,
  "changelog-draft": changelogDraftRecipe,
} satisfies Record<OfficialInitRecipeId, OfficialInitRecipe & { id: OfficialInitRecipeId }>;

export function listOfficialInitRecipes(): OfficialInitRecipe[] {
  return supportedOfficialInitRecipes.map((id) => officialInitRecipeRegistry[id]);
}

export function officialInitRecipeConfigTs(recipe?: string): string {
  return resolveOfficialInitRecipe(recipe).configTs;
}

export function officialInitRecipeFiles(recipe?: string): readonly OfficialInitRecipeFile[] {
  return resolveOfficialInitRecipe(recipe).files ?? [];
}

export function officialInitRecipeWorkflowEnvSecrets(
  recipe?: string,
): readonly OfficialInitRecipeWorkflowEnvSecret[] {
  return resolveOfficialInitRecipe(recipe).workflowEnvSecrets ?? [];
}

function resolveOfficialInitRecipe(
  recipe?: string,
): OfficialInitRecipe & { id: OfficialInitRecipeId } {
  const id = recipe ?? "default-review";
  if (!isOfficialInitRecipeId(id)) {
    throw new Error(
      `Unsupported pipr init recipe '${id}'. Supported recipes: ${supportedOfficialInitRecipes.join(
        ", ",
      )}.`,
    );
  }
  return officialInitRecipeRegistry[id];
}

function isOfficialInitRecipeId(recipe: string): recipe is OfficialInitRecipeId {
  return (supportedOfficialInitRecipes as readonly string[]).includes(recipe);
}
