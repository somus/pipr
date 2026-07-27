export function azureOrganizationFromUrl(value: string): string | undefined {
  const url = new URL(value);
  const path = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (url.hostname === "dev.azure.com") return path[0];
  if (url.hostname.endsWith(".visualstudio.com")) return url.hostname.split(".")[0];
  return path.at(-1);
}

export function normalizeAzureCollectionUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Azure DevOps collection URL must be an HTTPS URL without credentials");
  }
  if (!azureOrganizationFromUrl(value)) {
    throw new Error("Azure DevOps collection URL must include an organization or collection");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function isAzureDevOpsServicesUrl(value: string): boolean {
  const hostname = new URL(value).hostname;
  return hostname === "dev.azure.com" || hostname.endsWith(".visualstudio.com");
}
