/** A local OpenAI-compatible Chat Completions server that streams scripted replies, for custom provider tests. */
export type FakeGatewayRequest = {
  path: string;
  authorization: string | null;
  body: { model?: unknown; [key: string]: unknown };
};

export type FakeOpenAIGateway = {
  /** Base URL to configure as the provider `baseUrl`, ending in `/v1`. */
  baseUrl: string;
  requests: FakeGatewayRequest[];
  stop(): Promise<void>;
};

/** `reply` returns the assistant text for each request; a pending promise holds the request open. */
export function startFakeOpenAIGateway(options: {
  reply(request: FakeGatewayRequest, index: number): string | Promise<string>;
}): FakeOpenAIGateway {
  const requests: FakeGatewayRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(httpRequest) {
      const url = new URL(httpRequest.url);
      if (httpRequest.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        return new Response("not found", { status: 404 });
      }
      const request: FakeGatewayRequest = {
        path: url.pathname,
        authorization: httpRequest.headers.get("authorization"),
        body: (await httpRequest.json()) as FakeGatewayRequest["body"],
      };
      const index = requests.push(request) - 1;
      const text = await options.reply(request, index);
      return new Response(completionStream(String(request.body.model), text), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    requests,
    async stop() {
      await server.stop(true);
    },
  };
}

function completionStream(model: string, text: string): string {
  const chunk = (fields: Record<string, unknown>) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created: 0,
      model,
      ...fields,
    })}\n\n`;
  return [
    chunk({
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    }),
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    chunk({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }),
    "data: [DONE]\n\n",
  ].join("");
}
