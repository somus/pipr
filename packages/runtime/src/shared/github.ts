export const githubApiVersion = "2026-03-10";

export function githubActor(login: string | undefined): { login: string } | undefined {
  return login ? { login } : undefined;
}

export function parseRepoSlug(value: string): { owner: string; repo: string } {
  const [owner, repo, ...extra] = value.split("/");
  if (!owner || !repo || extra.length > 0) {
    throw new Error(`GitHub repo must be in owner/repo form, got '${value}'`);
  }
  return { owner, repo };
}
