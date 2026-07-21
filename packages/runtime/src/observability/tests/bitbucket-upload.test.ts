import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { uploadBitbucketRunBundle } from "../bitbucket-upload.js";
import { startFileRunRecorder } from "../recorder.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Bitbucket run upload", () => {
  it("deletes only expired reserved downloads and uploads with separate artifact credentials", async () => {
    const root = await temporaryDirectory();
    const recorder = await startFileRunRecorder({
      rootDirectory: root,
      env: {},
      externalUpload: "pending",
    });
    await recorder.finish({ kind: "review", outcome: "succeeded" });
    const requests: Request[] = [];
    let uploadStateWhenPosted: string | undefined;

    const result = await uploadBitbucketRunBundle({
      directory: recorder.directory,
      repository: "workspace/pipr",
      changeNumber: 42,
      executionId: recorder.executionId,
      email: "artifact@example.com",
      token: "artifact-token",
      readEmail: "review@example.com",
      readToken: "review-token",
      now: new Date("2026-07-20T00:00:00.000Z"),
      fetch: async (input, init) => {
        const request =
          input instanceof Request ? new Request(input, init) : new Request(String(input), init);
        requests.push(request);
        if (request.method === "GET") {
          return Response.json({
            values: [
              {
                name: `pipr-run-v1-pr-1-${"a".repeat(32)}.tar.gz`,
                created_on: "2026-06-01T00:00:00.000Z",
              },
              { name: "release.tar.gz", created_on: "2020-01-01T00:00:00.000Z" },
            ],
          });
        }
        if (request.method === "DELETE") return new Response(null, { status: 204 });
        if (request.method === "POST") {
          uploadStateWhenPosted = JSON.parse(
            await readFile(path.join(recorder.directory, "run.json"), "utf8"),
          ).export.externalUpload;
          return new Response(null, { status: 201 });
        }
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      },
    });

    expect(result.status).toBe("available");
    expect(uploadStateWhenPosted).toBe("pending");
    expect(requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
    expect(requests.find((request) => request.method === "DELETE")?.url).toContain(
      `pipr-run-v1-pr-1-${"a".repeat(32)}.tar.gz`,
    );
    const upload = requests.find((request) => request.method === "POST");
    expect(requests.find((request) => request.method === "GET")?.headers.get("authorization")).toBe(
      `Basic ${Buffer.from("review@example.com:review-token").toString("base64")}`,
    );
    expect(
      requests.find((request) => request.method === "DELETE")?.headers.get("authorization"),
    ).toBe(`Basic ${Buffer.from("artifact@example.com:artifact-token").toString("base64")}`);
    expect(upload?.headers.get("authorization")).toBe(
      `Basic ${Buffer.from("artifact@example.com:artifact-token").toString("base64")}`,
    );
    expect(await upload?.formData()).toBeDefined();
    expect(
      JSON.parse(await readFile(path.join(recorder.directory, "run.json"), "utf8")).export
        .externalUpload,
    ).toBe("available");
  });

  it("records upload failure without throwing into the completed review", async () => {
    const root = await temporaryDirectory();
    const recorder = await startFileRunRecorder({
      rootDirectory: root,
      env: {},
      externalUpload: "pending",
    });
    await recorder.finish({ kind: "review", outcome: "succeeded" });

    let responseCancelled = false;
    const result = await uploadBitbucketRunBundle({
      directory: recorder.directory,
      repository: "workspace/pipr",
      changeNumber: 42,
      executionId: recorder.executionId,
      email: "artifact@example.com",
      token: "artifact-token",
      fetch: async (input, init) => {
        const request =
          input instanceof Request ? new Request(input, init) : new Request(String(input), init);
        if (request.method === "GET") return Response.json({ values: [] });
        return new Response(
          new ReadableStream({
            cancel() {
              responseCancelled = true;
            },
          }),
          { status: 403 },
        );
      },
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("HTTP 403");
    expect(responseCancelled).toBe(true);
    expect(
      JSON.parse(await readFile(path.join(recorder.directory, "run.json"), "utf8")).export
        .externalUpload,
    ).toBe("failed");
  });

  it("does not follow Downloads pagination outside the configured collection", async () => {
    const root = await temporaryDirectory();
    const recorder = await startFileRunRecorder({ rootDirectory: root, env: {} });
    await recorder.finish({ kind: "review", outcome: "succeeded" });
    const requests: Request[] = [];

    const result = await uploadBitbucketRunBundle({
      directory: recorder.directory,
      repository: "workspace/pipr",
      changeNumber: 42,
      executionId: recorder.executionId,
      email: "artifact@example.com",
      token: "artifact-token",
      fetch: async (input, init) => {
        const request =
          input instanceof Request ? new Request(input, init) : new Request(String(input), init);
        requests.push(request);
        if (request.method === "POST") return new Response(null, { status: 201 });
        return Response.json({ values: [], next: "https://attacker.example/downloads?page=2" });
      },
    });

    expect(result.status).toBe("available");
    expect(result.warning).toContain("outside the configured collection");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toStartWith("https://api.bitbucket.org/");
    expect(requests.some((request) => request.url.startsWith("https://attacker.example"))).toBe(
      false,
    );
  });

  it("uploads the current bundle when expired artifact lookup fails", async () => {
    const root = await temporaryDirectory();
    const recorder = await startFileRunRecorder({
      rootDirectory: root,
      env: {},
      externalUpload: "pending",
    });
    await recorder.finish({ kind: "review", outcome: "succeeded" });
    const methods: string[] = [];

    const result = await uploadBitbucketRunBundle({
      directory: recorder.directory,
      repository: "workspace/pipr",
      changeNumber: 42,
      executionId: recorder.executionId,
      email: "artifact@example.com",
      token: "artifact-token",
      readEmail: "review@example.com",
      readToken: "review-token",
      fetch: async (input, init) => {
        const request =
          input instanceof Request ? new Request(input, init) : new Request(String(input), init);
        methods.push(request.method);
        return request.method === "GET"
          ? new Response("payment required", { status: 402 })
          : new Response(null, { status: 201 });
      },
    });

    expect(methods).toEqual(["GET", "POST"]);
    expect(result).toEqual({
      status: "available",
      warning: "Bitbucket Downloads lookup failed with HTTP 402",
    });
    expect(
      JSON.parse(await readFile(path.join(recorder.directory, "run.json"), "utf8")).export
        .externalUpload,
    ).toBe("available");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pipr-bitbucket-upload-"));
  temporaryDirectories.push(directory);
  return directory;
}
