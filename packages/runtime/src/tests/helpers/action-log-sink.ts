import type { ActionLogSink } from "../../shared/logging.js";

export type MemoryActionLogSink = {
  logSink: ActionLogSink;
  messages: string[];
  notices: string[];
  groups: string[];
};

export function memoryActionLogSink(): MemoryActionLogSink {
  const messages: string[] = [];
  const notices: string[] = [];
  const groups: string[] = [];
  return {
    messages,
    notices,
    groups,
    logSink: {
      info(message) {
        messages.push(message);
      },
      notice(message) {
        messages.push(message);
        notices.push(message);
      },
      warning(message) {
        messages.push(message);
      },
      error(message) {
        messages.push(message);
      },
      debug(message) {
        messages.push(message);
      },
      async group(name, run) {
        groups.push(name);
        return await run();
      },
    },
  };
}
