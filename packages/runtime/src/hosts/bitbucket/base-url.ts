export function trustedBitbucketDataCenterBaseUrl(value: string | undefined): string {
  if (!value) throw new Error("BITBUCKET_BASE_URL is required for Bitbucket Data Center API calls");

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Bitbucket Data Center base URL must be an HTTPS URL without credentials");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Bitbucket Data Center base URL must be an HTTPS URL without credentials");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url.href;
}
