import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

let copyResult = true;
let copyCalls: string[] = [];

const copyToClipboardMock = mock((text: string) => {
  copyCalls.push(text);
  return Promise.resolve(copyResult);
});

mock.module("copy-to-clipboard", () => ({
  default: copyToClipboardMock,
}));

const { CopyButton } = await import("./copy-button");

type ReactActGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

const reactGlobal = globalThis as ReactActGlobal;

const originalGlobals = {
  document: globalThis.document,
  event: globalThis.Event,
  htmlElement: globalThis.HTMLElement,
  isReactActEnvironment: reactGlobal.IS_REACT_ACT_ENVIRONMENT,
  navigator: globalThis.navigator,
  node: globalThis.Node,
  window: globalThis.window,
};

let timeoutCallback: (() => void) | undefined;
let clearedTimer: number | undefined;
let root: Root;
let rootUnmounted = false;
let container: HTMLElement;

function getButton() {
  const button = container.querySelector("button");

  if (!(button instanceof window.HTMLButtonElement)) {
    throw new Error("Expected CopyButton to render a button");
  }

  return button;
}

beforeEach(() => {
  copyResult = true;
  copyCalls = [];
  timeoutCallback = undefined;
  clearedTimer = undefined;
  rootUnmounted = false;
  mock.clearAllMocks();

  const happyWindow = new HappyWindow();
  const timeoutHandle = 0 as unknown as ReturnType<typeof happyWindow.setTimeout>;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: happyWindow,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: happyWindow.document,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: happyWindow.navigator,
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: happyWindow.HTMLElement,
  });
  Object.defineProperty(globalThis, "Event", {
    configurable: true,
    value: happyWindow.Event,
  });
  Object.defineProperty(globalThis, "Node", {
    configurable: true,
    value: happyWindow.Node,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });

  happyWindow.setTimeout = ((callback: (...args: unknown[]) => unknown) => {
    timeoutCallback = () => {
      callback();
    };
    return timeoutHandle;
  }) as typeof happyWindow.setTimeout;
  happyWindow.clearTimeout = ((timer: ReturnType<typeof happyWindow.setTimeout>) => {
    clearedTimer = timer === timeoutHandle ? 0 : undefined;
  }) as typeof happyWindow.clearTimeout;

  const happyContainer = happyWindow.document.createElement("div");
  happyWindow.document.body.append(happyContainer);
  container = happyContainer as unknown as HTMLElement;
  root = createRoot(container);
});

afterEach(async () => {
  if (!rootUnmounted) {
    await act(async () => {
      root.unmount();
      rootUnmounted = true;
    });
  }

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalGlobals.window,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: originalGlobals.document,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: originalGlobals.navigator,
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: originalGlobals.htmlElement,
  });
  Object.defineProperty(globalThis, "Event", {
    configurable: true,
    value: originalGlobals.event,
  });
  Object.defineProperty(globalThis, "Node", {
    configurable: true,
    value: originalGlobals.node,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: originalGlobals.isReactActEnvironment,
  });
});

describe("CopyButton", () => {
  it("copies text and resets the success label", async () => {
    await act(async () => {
      root.render(<CopyButton copyText="pipr init" label="Copy" />);
    });

    const button = getButton();

    await act(async () => {
      button.click();
    });

    expect(copyCalls).toEqual(["pipr init"]);
    expect(button.querySelector("[data-copy-label]")?.textContent).toBe("Copied");
    expect(button.querySelector('[role="status"]')?.textContent).toBe("Copy copied");

    await act(async () => {
      timeoutCallback?.();
    });

    expect(button.querySelector("[data-copy-label]")?.textContent).toBe("Copy");
    expect(button.querySelector('[role="status"]')?.textContent).toBe("");
  });

  it("does not show success when copying fails", async () => {
    copyResult = false;

    await act(async () => {
      root.render(<CopyButton copyText="pipr init" label="Copy" />);
    });

    const button = getButton();

    await act(async () => {
      button.click();
    });

    expect(copyCalls).toEqual(["pipr init"]);
    expect(button.querySelector("[data-copy-label]")?.textContent).toBe("Copy");
    expect(timeoutCallback).toBeUndefined();
  });

  it("clears the reset timer on unmount", async () => {
    await act(async () => {
      root.render(<CopyButton copyText="pipr init" label="Copy" />);
    });

    const button = getButton();

    await act(async () => {
      button.click();
    });

    await act(async () => {
      root.unmount();
      rootUnmounted = true;
    });

    expect(clearedTimer).toBe(0);
  });
});
