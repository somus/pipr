import type { Provider } from "@earendil-works/pi-ai";
import {
  createAgentWorkerLineDecoder,
  encodeAgentWorkerMessage,
  type SupervisorMessage,
  type WorkerMessage,
  workerMessageSchema,
} from "../protocol.js";
import { runAgentWorker } from "../worker.js";

export type InProcessWorker = {
  send(message: SupervisorMessage): void;
  next(predicate: (message: WorkerMessage) => boolean): Promise<WorkerMessage>;
  messages: WorkerMessage[];
  close(): Promise<void>;
};

export function startInProcessWorker(options: {
  providers: Provider[];
  env?: NodeJS.ProcessEnv;
  storePath?: string;
}): InProcessWorker {
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const messages: WorkerMessage[] = [];
  const waiters: Array<{
    predicate: (message: WorkerMessage) => boolean;
    resolve(message: WorkerMessage): void;
  }> = [];
  const decoder = createAgentWorkerLineDecoder(workerMessageSchema, {
    onMessage(message) {
      messages.push(message);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(message)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    },
    onError(error) {
      throw error;
    },
  });
  async function* input(): AsyncIterable<string> {
    while (true) {
      const line = queue.shift();
      if (line !== undefined) {
        yield line;
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  const done = runAgentWorker({
    input: input(),
    write: (line) => decoder.push(line),
    env: options.env ?? {},
    storePath: options.storePath,
    providers: options.providers,
  });
  const push = (line: string) => {
    queue.push(line);
    wake?.();
  };
  return {
    messages,
    send(message) {
      push(encodeAgentWorkerMessage(message));
    },
    next(predicate) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    },
    async close() {
      ended = true;
      wake?.();
      await done;
    },
  };
}
