"use client";

import { Copy01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import copyToClipboard from "copy-to-clipboard";
import { useEffect, useRef, useState } from "react";

type CopyButtonProps = {
  copyText: string;
  label: string;
  ariaLabel?: string;
  className?: string;
};

const baseButtonClass =
  "inline-flex min-h-9 shrink-0 items-center gap-2 rounded-md px-2.5 text-xs font-medium text-fd-muted-foreground transition-[background-color,color] hover:bg-fd-accent hover:text-fd-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fd-ring";

export function CopyButton({ copyText, label, ariaLabel, className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);
  const mounted = useRef(true);
  const buttonClass = [baseButtonClass, className].filter(Boolean).join(" ");

  useEffect(() => {
    return () => {
      mounted.current = false;

      if (resetTimer.current !== null) {
        window.clearTimeout(resetTimer.current);
        resetTimer.current = null;
      }
    };
  }, []);

  async function handleCopy() {
    let copiedToClipboard = false;

    try {
      copiedToClipboard = await copyToClipboard(copyText);
    } catch {
      copiedToClipboard = false;
    }

    if (!copiedToClipboard || !mounted.current) {
      return;
    }

    setCopied(true);

    if (resetTimer.current !== null) {
      window.clearTimeout(resetTimer.current);
    }

    resetTimer.current = window.setTimeout(() => {
      setCopied(false);
      resetTimer.current = null;
    }, 1600);
  }

  return (
    <button
      type="button"
      className={buttonClass}
      aria-label={ariaLabel ?? label}
      data-copy-text={copyText}
      data-copy-command={copyText}
      onClick={handleCopy}
    >
      <HugeiconsIcon icon={Copy01Icon} size={14} strokeWidth={1.8} aria-hidden="true" />
      <span data-copy-label>{copied ? "Copied" : label}</span>
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? `${label} copied` : ""}
      </span>
    </button>
  );
}
