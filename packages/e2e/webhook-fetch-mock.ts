const originalFetch = globalThis.fetch;
const responses: Record<string, unknown> = {
  "gitlab.com": { id: 42, path_with_namespace: "group/project" },
  "dev.azure.com": {
    id: "repository-id",
    name: "repository",
    project: { id: "project-id", name: "project" },
  },
  "api.bitbucket.org": {
    uuid: "{repository-id}",
    name: "repository",
    full_name: "workspace/repository",
    slug: "repository",
    links: { html: { href: "https://bitbucket.org/workspace/repository" } },
  },
};

const mockFetch = async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : input);
  const response = responses[url.hostname];
  if (!response) throw new Error(`unexpected webhook fixture request: ${url}`);
  return Response.json(response);
};

globalThis.fetch = Object.assign(mockFetch, { preconnect: originalFetch.preconnect });
