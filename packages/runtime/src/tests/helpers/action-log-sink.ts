import type { ActionLogRecord, ActionLogSink } from "../../shared/logging.js";

export type MemoryActionLogSink = {
  logSink: ActionLogSink;
  records: ActionLogRecord[];
  messages: string[];
  notices: string[];
  groups: string[];
};

export function memoryActionLogSink(): MemoryActionLogSink {
  const messages: string[] = [];
  const records: ActionLogRecord[] = [];
  const notices: string[] = [];
  const groups: string[] = [];
  return {
    messages,
    records,
    notices,
    groups,
    logSink: {
      log(record) {
        records.push(record);
        const message = formatActionLogRecord(record);
        messages.push(message);
        if (record.level === "notice") {
          notices.push(message);
        }
      },
      async group(name, run) {
        groups.push(name);
        return await run();
      },
    },
  };
}

function formatActionLogRecord(record: ActionLogRecord): string {
  const line = JSON.stringify({
    level: record.level,
    event: record.event,
    ...record.fields,
  });
  return record.text === undefined ? line : `${line}\n${record.text}`;
}
