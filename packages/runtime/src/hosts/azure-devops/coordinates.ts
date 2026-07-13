export function azureOrganizationFromUrl(value: string): string | undefined {
  const url = new URL(value);
  return url.hostname === "dev.azure.com"
    ? url.pathname.split("/").filter(Boolean)[0]
    : url.hostname.split(".")[0];
}
