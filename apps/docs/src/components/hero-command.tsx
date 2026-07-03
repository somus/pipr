import { CopyButton } from "@/components/copy-button";

export function HeroCommand({ command }: { command: string }) {
  return (
    <aside className="pipr-run-card rounded-lg p-3" aria-label="Pipr init command">
      <div className="flex min-h-10 items-center gap-3">
        <code className="min-w-0 flex-1 truncate font-mono text-sm text-fd-secondary-foreground">
          <span className="text-fd-primary">$</span> {command}
        </code>
        <CopyButton copyText={command} label="Copy" ariaLabel={`Copy ${command}`} />
      </div>
    </aside>
  );
}
