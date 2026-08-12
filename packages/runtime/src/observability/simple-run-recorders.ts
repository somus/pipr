import { randomBytes } from "node:crypto";
import type { InMemoryRunCapture, RunRecorder } from "./recorder-types.js";

export function createNoopRunRecorder(): RunRecorder {
  return {
    executionId: randomBytes(16).toString("hex"),
    directory: "",
    logSink: {
      log() {},
      async group(_name, run) {
        return await run();
      },
    },
    observer: {
      async recordArtifact() {},
      async beginAgentAttempt() {
        return { event() {}, async finish() {} };
      },
    },
    async addArtifact() {},
    async discard() {},
    async finish() {},
  };
}

export function createInMemoryRunRecorder(options: { executionId?: string } = {}): RunRecorder & {
  capture: InMemoryRunCapture;
} {
  const capture: InMemoryRunCapture = {
    logs: [],
    groups: [],
    artifacts: [],
    attempts: [],
    discarded: false,
  };
  return {
    executionId: options.executionId ?? randomBytes(16).toString("hex"),
    directory: "memory://pipr-run",
    capture,
    logSink: {
      log(record) {
        capture.logs.push(record);
      },
      async group(name, run) {
        capture.groups.push(name);
        return await run();
      },
    },
    observer: {
      async recordArtifact(artifact) {
        capture.artifacts.push(artifact);
      },
      async beginAgentAttempt(attemptOptions) {
        const attempt: InMemoryRunCapture["attempts"][number] = {
          options: attemptOptions,
          events: [],
        };
        capture.attempts.push(attempt);
        return {
          event(event) {
            attempt.events.push(event);
          },
          async finish(result) {
            attempt.result = result;
          },
        };
      },
    },
    async addArtifact(artifact) {
      capture.artifacts.push(artifact);
    },
    async discard() {
      capture.discarded = true;
    },
    async finish(result) {
      capture.result = result;
    },
  };
}
