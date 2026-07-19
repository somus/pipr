export const appName = "Pipr";
export const docsRoute = "/docs";
const siteOrigin = "https://pipr.run";

export function siteUrl(pathname: string): string {
  return new URL(pathname, siteOrigin).href;
}

export const gitConfig = {
  user: "somus",
  repo: "pipr",
  branch: "main",
};
