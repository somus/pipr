export function resolveBitbucketCollectionPageUrl(value: string, collectionUrl: string): string {
  const collection = new URL(collectionUrl);
  const resolved = new URL(value, collection);
  if (resolved.origin !== collection.origin || resolved.pathname !== collection.pathname) {
    throw new Error("Bitbucket pagination points outside the configured collection");
  }
  return resolved.toString();
}
