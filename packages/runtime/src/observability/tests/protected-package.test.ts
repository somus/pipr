import { afterEach, describe, expect, it } from "bun:test";
import {
  appendFile,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  generateRunBundleIdentity,
  openRunBundlePackage,
  prepareRunBundlePackage,
  validateRunBundlePackage,
} from "../../index.js";
import { startFileRunRecorder } from "../recorder.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("protected Run Bundle packages", () => {
  it("publishes content-free metadata and decrypts diagnostics with a matching identity", async () => {
    const root = await temporaryDirectory();
    const recorder = await diagnosticBundle(root);

    const key = await generateRunBundleIdentity();
    const prepared = await prepareRunBundlePackage({
      bundleDirectory: recorder.directory,
      destinationRoot: path.join(root, "published"),
      recipients: [key.recipient],
    });

    expect(prepared.envelope.protection).toBe("age");
    expect((await readdir(prepared.directory)).sort()).toEqual([
      "diagnostic.tar.gz.age",
      "envelope.json",
      "metadata.tar.gz",
    ]);
    expect((await stat(path.dirname(prepared.directory))).mode & 0o777).toBe(0o755);
    expect((await stat(prepared.directory)).mode & 0o777).toBe(0o755);
    for (const file of await readdir(prepared.directory)) {
      expect((await stat(path.join(prepared.directory, file))).mode & 0o777).toBe(0o644);
    }

    const metadataView = await openRunBundlePackage({
      packageDirectory: prepared.directory,
      destination: path.join(root, "metadata-view"),
    });
    expect(metadataView.diagnostic).toBe("locked");
    expect(metadataView.bundle.manifest.capture.mode).toBe("metadata");
    expect(metadataView.bundle.manifest.artifacts[0]?.path).toBe("artifacts/prompt-1.omitted");
    const publicView = JSON.stringify(metadataView.bundle);
    for (const value of privateValues) expect(publicView).not.toContain(value);
    const providerBytes = Buffer.concat(
      await Promise.all(
        (await readdir(prepared.directory)).map((file) =>
          readFile(path.join(prepared.directory, file)),
        ),
      ),
    ).toString("utf8");
    for (const value of privateValues) expect(providerBytes).not.toContain(value);

    const diagnosticView = await openRunBundlePackage({
      packageDirectory: prepared.directory,
      destination: path.join(root, "diagnostic-view"),
      identities: [key.identity],
    });
    expect(diagnosticView.diagnostic).toBe("available");
    expect(diagnosticView.bundle.manifest.capture.mode).toBe("diagnostic");
    expect(
      await readFile(
        path.join(diagnosticView.bundle.directory, "artifacts", "prompt-001-initial.md"),
        "utf8",
      ),
    ).toBe("private source body");
  });

  it("supports multiple recipients and rejects a non-matching identity", async () => {
    const root = await temporaryDirectory();
    const recorder = await diagnosticBundle(root);
    const first = await generateRunBundleIdentity();
    const second = await generateRunBundleIdentity();
    const wrong = await generateRunBundleIdentity();
    const prepared = await prepareRunBundlePackage({
      bundleDirectory: recorder.directory,
      destinationRoot: path.join(root, "published"),
      recipients: [first.recipient, second.recipient],
    });

    const opened = await openRunBundlePackage({
      packageDirectory: prepared.directory,
      destination: path.join(root, "second-recipient"),
      identities: [second.identity],
    });
    expect(opened.diagnostic).toBe("available");
    await expect(
      openRunBundlePackage({
        packageDirectory: prepared.directory,
        destination: path.join(root, "wrong-recipient"),
        identities: [wrong.identity],
      }),
    ).rejects.toThrow();
  });

  it("publishes metadata only without recipients", async () => {
    const root = await temporaryDirectory();
    const recorder = await diagnosticBundle(root);
    const prepared = await prepareRunBundlePackage({
      bundleDirectory: recorder.directory,
      destinationRoot: path.join(root, "published"),
    });

    expect(prepared.envelope).toMatchObject({
      protection: "metadata",
      diagnosticState: "not-captured",
    });
    expect(await readdir(prepared.directory)).toEqual(
      expect.arrayContaining(["envelope.json", "metadata.tar.gz"]),
    );
    expect(await readdir(prepared.directory)).not.toContain("diagnostic.tar.gz.age");
  });

  it("does not report diagnostic archive construction failures as encryption failures", async () => {
    const root = await temporaryDirectory();
    const recorder = await diagnosticBundle(root, `${"a".repeat(101)}.md`);
    const key = await generateRunBundleIdentity();
    const published = path.join(root, "published");

    await expect(
      prepareRunBundlePackage({
        bundleDirectory: recorder.directory,
        destinationRoot: published,
        recipients: [key.recipient],
      }),
    ).rejects.toThrow("too long for tar");
    expect(await readdir(published)).toEqual([]);
  });

  it("rejects extra files, symlinks, and hash mismatches", async () => {
    const root = await temporaryDirectory();
    const recorder = await diagnosticBundle(root);
    const prepared = await prepareRunBundlePackage({
      bundleDirectory: recorder.directory,
      destinationRoot: path.join(root, "published"),
    });

    const extra = path.join(prepared.directory, "extra.txt");
    await writeFile(extra, "unexpected");
    await expect(validateRunBundlePackage(prepared.directory)).rejects.toThrow(
      "unexpected or missing",
    );
    await rm(extra);

    const link = path.join(prepared.directory, "linked");
    await symlink(path.join(prepared.directory, "envelope.json"), link);
    await expect(validateRunBundlePackage(prepared.directory)).rejects.toThrow("non-file");
    await rm(link);

    await appendFile(path.join(prepared.directory, "metadata.tar.gz"), "tampered");
    await expect(validateRunBundlePackage(prepared.directory)).rejects.toThrow("size mismatch");
  });
});

const privateValues = [
  "private source body",
  "private_source_body",
  "private stderr",
  "private tool payload",
  "private reasoning",
  "private environment secret",
  "/Users/private/project",
];

async function diagnosticBundle(root: string, artifactName = "prompt-001-initial.md") {
  const recorder = await startFileRunRecorder({
    rootDirectory: path.join(root, "capture"),
    env: { PIPR_TEST_SECRET: "private environment secret" },
    mode: "diagnostic",
  });
  recorder.logSink.log({
    level: "error",
    event: "task failed",
    fields: {
      task: "review",
      error: "private stderr",
      payload: "private tool payload",
      reasoning: "private reasoning",
      path: "/Users/private/project",
    },
    text: "private stderr",
  });
  await recorder.logSink.group("private source body", async () => undefined);
  await recorder.addArtifact({
    kind: "prompt",
    name: artifactName,
    mediaType: "text/markdown",
    content: "private source body",
    sensitive: true,
  });
  await recorder.finish({
    kind: "review",
    outcome: "succeeded",
    repository: {
      host: "github",
      repository: "somus/pipr",
      changeNumber: 42,
    },
  });
  return recorder;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pipr-protected-package-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
