/** Protection recorded in a published Run Bundle package envelope. */
type RunArtifactProtection = "metadata" | "age";

type RunArtifactIdentity = {
  executionId: string;
  protection?: RunArtifactProtection;
  changeNumber?: number;
};

const artifactNamePattern = /^pipr-run-v1-(?:(metadata|age)-)?(?:pr-(\d+)-)?([a-f0-9]{32})$/;

/** Names the provider artifact that carries one published Run Bundle package. */
export function buildRunArtifactName(identity: {
  executionId: string;
  protection: RunArtifactProtection;
  changeNumber?: number;
}): string {
  const change = identity.changeNumber ? `pr-${identity.changeNumber}-` : "";
  return `pipr-run-v1-${identity.protection}-${change}${identity.executionId}`;
}

export function parseRunArtifactName(name: string): RunArtifactIdentity | undefined {
  const match = artifactNamePattern.exec(name);
  if (!match) return undefined;
  const [, protection, changeNumber, executionId] = match;
  if (!executionId) return undefined;
  return {
    executionId,
    ...(protection === "metadata" || protection === "age" ? { protection } : {}),
    ...(changeNumber ? { changeNumber: Number(changeNumber) } : {}),
  };
}
