export const stableSemverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function compareStableSemver(left: string, right: string): number {
  const leftParts = stableSemverPattern.exec(left);
  const rightParts = stableSemverPattern.exec(right);
  if (!leftParts || !rightParts) {
    throw new Error(`cannot compare non-stable semver versions: ${left}, ${right}`);
  }
  return (
    Number(leftParts[1]) - Number(rightParts[1]) ||
    Number(leftParts[2]) - Number(rightParts[2]) ||
    Number(leftParts[3]) - Number(rightParts[3])
  );
}
