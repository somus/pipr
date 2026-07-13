import type { RuntimeLogRecord, RuntimeLogSink } from "../../shared/logging.js";

export type MemoryRuntimeLogSink = {
  logSink: RuntimeLogSink;
  records: RuntimeLogRecord[];
  messages: string[];
  notices: string[];
  groups: string[];
};

export function memoryRuntimeLogSink(): MemoryRuntimeLogSink {
  const messages: string[] = [];
  const records: RuntimeLogRecord[] = [];
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
        const message = formatRuntimeLogRecord(record);
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

function formatRuntimeLogRecord(record: RuntimeLogRecord): string {
  const line = JSON.stringify({
    level: record.level,
    event: record.event,
    ...record.fields,
  });
  return record.text === undefined ? line : `${line}\n${record.text}`;
}
