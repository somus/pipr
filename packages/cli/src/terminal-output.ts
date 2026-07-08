export function sanitizeTerminalMessage(message: string): string {
  let sanitized = "";
  for (let index = 0; index < message.length; index += 1) {
    const code = message.charCodeAt(index);
    if (code === 0x1b) {
      index = skipTerminalControlSequence(message, index);
      continue;
    }
    if (code === c1OscIntroducer) {
      index = skipUntilTerminator(message, index + 1, bellTerminator);
      continue;
    }
    if (c1StringControlIntroducers.has(code)) {
      index = skipUntilTerminator(message, index + 1);
      continue;
    }
    if (code === c1CsiIntroducer) {
      index = skipCsiSequence(message, index + 1);
      continue;
    }
    if (isUnsafeTerminalControl(code)) {
      continue;
    }
    sanitized += message[index];
  }
  return sanitized;
}

const oscIntroducer = 0x5d;
const csiIntroducer = 0x5b;
const c1OscIntroducer = 0x9d;
const c1CsiIntroducer = 0x9b;
const bellTerminator = 0x07;
const stringTerminator = 0x9c;
const stringControlIntroducers = new Set([0x50, 0x58, 0x5e, 0x5f]);
const c1StringControlIntroducers = new Set([0x90, 0x98, 0x9e, 0x9f]);

function skipTerminalControlSequence(message: string, index: number): number {
  const next = message.charCodeAt(index + 1);
  if (Number.isNaN(next)) {
    return index;
  }
  if (next === oscIntroducer) {
    return skipUntilTerminator(message, index + 2, bellTerminator);
  }
  if (stringControlIntroducers.has(next)) {
    return skipUntilTerminator(message, index + 2);
  }
  if (next === csiIntroducer) {
    return skipCsiSequence(message, index + 2);
  }
  if (isEscapeIntermediate(next)) {
    return skipEscapeSequenceWithIntermediates(message, index + 1);
  }
  if (isSingleEscapeSequenceFinal(next)) {
    return index + 1;
  }
  return index;
}

function skipCsiSequence(message: string, index: number): number {
  for (let cursor = index; cursor < message.length; cursor += 1) {
    const code = message.charCodeAt(cursor);
    if (code >= 0x40 && code <= 0x7e) {
      return cursor;
    }
  }
  return message.length - 1;
}

function skipUntilTerminator(message: string, index: number, terminator?: number): number {
  for (let cursor = index; cursor < message.length; cursor += 1) {
    const code = message.charCodeAt(cursor);
    if (code === stringTerminator) {
      return cursor;
    }
    if (terminator !== undefined && code === terminator) {
      return cursor;
    }
    if (code === 0x1b && cursor + 1 < message.length && message.charCodeAt(cursor + 1) === 0x5c) {
      return cursor + 1;
    }
  }
  return message.length - 1;
}

function skipEscapeSequenceWithIntermediates(message: string, index: number): number {
  for (let cursor = index; cursor < message.length; cursor += 1) {
    const code = message.charCodeAt(cursor);
    if (isEscapeIntermediate(code)) {
      continue;
    }
    if (isSingleEscapeSequenceFinal(code)) {
      return cursor;
    }
    return cursor - 1;
  }
  return message.length - 1;
}

function isEscapeIntermediate(code: number): boolean {
  return code >= 0x20 && code <= 0x2f;
}

function isSingleEscapeSequenceFinal(code: number): boolean {
  return code >= 0x30 && code <= 0x7e;
}

function isUnsafeTerminalControl(code: number): boolean {
  return (code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f);
}
