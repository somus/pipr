import { GithubIcon, SparklesIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import type { ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";
import { piprAgentSetupPrompt } from "@/lib/agent-prompt";
import { baseOptions } from "@/lib/layout.shared";
import { gitConfig } from "@/lib/shared";

export const Route = createFileRoute("/")({
  component: Home,
});

type LandingLink = {
  title: string;
  description: ReactNode;
  path: string;
};

type ConceptCard = {
  title: string;
  description: ReactNode;
  image: string;
  cardClassName: string;
  imageClassName: string;
};

const installCommandLines = [
  {
    id: "install",
    command: "curl -fsSL https://pipr.run/install.sh | sh",
  },
  {
    id: "init",
    command: "pipr init",
  },
];

const installCommand = installCommandLines.map((line) => line.command).join("\n");

const conceptCards = [
  {
    title: "Config lives in your repo",
    description: (
      <>
        <InlineCode>.pipr/config.ts</InlineCode> is the review policy that maintainers own and
        review.
      </>
    ),
    image: "/images/pipr/home-illustration-lean-core.svg",
    cardClassName:
      "border-[#33534a] bg-[radial-gradient(ellipse_at_52%_18%,rgba(58,137,118,0.08),transparent_54%),radial-gradient(circle_at_10%_10%,rgba(199,255,95,0.012),transparent_34%),linear-gradient(145deg,#07110e_0%,#040807_100%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]",
    imageClassName: "mx-auto h-40 w-full max-w-none sm:h-48",
  },
  {
    title: "One runtime handles review",
    description: "Pipr builds the Diff Manifest, runs Pi, validates output, and publishes.",
    image: "/images/pipr/home-illustration-composable-workflows.svg",
    cardClassName:
      "border-[#4a416d] bg-[radial-gradient(ellipse_at_78%_20%,rgba(137,105,205,0.08),transparent_52%),radial-gradient(circle_at_24%_12%,rgba(86,91,150,0.018),transparent_40%),linear-gradient(145deg,#0d0d1b_0%,#070712_100%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]",
    imageClassName: "mx-auto h-40 w-full max-w-none sm:h-48",
  },
  {
    title: "Workflows compose on top",
    description: "Recipes, tasks, commands, and plugins extend the same core.",
    image: "/images/pipr/home-illustration-commands-plugins.svg",
    cardClassName:
      "border-[#25546a] bg-[radial-gradient(ellipse_at_44%_24%,rgba(14,102,142,0.11),transparent_56%),radial-gradient(circle_at_84%_4%,rgba(34,202,169,0.018),transparent_32%),linear-gradient(145deg,#061522_0%,#030a10_100%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]",
    imageClassName: "mx-auto h-40 w-full max-w-none sm:h-48",
  },
  {
    title: "Comments are validated first",
    description: "Pipr publishes one main review and capped inline comments after validation.",
    image: "/images/pipr/home-illustration-validated-review.svg",
    cardClassName:
      "border-[#4b473a] bg-[radial-gradient(ellipse_at_78%_26%,rgba(159,132,35,0.05),transparent_50%),radial-gradient(circle_at_16%_4%,rgba(255,255,255,0.01),transparent_34%),linear-gradient(145deg,#12110e_0%,#080806_100%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]",
    imageClassName: "mx-auto h-40 w-full max-w-none sm:h-48",
  },
] satisfies ConceptCard[];

const moreInfoLinks = [
  {
    title: "Quickstart",
    description: (
      <>
        Install the CLI, create <InlineCode>.pipr/config.ts</InlineCode>, and run your first review.
      </>
    ),
    path: "guide/quickstart",
  },
  {
    title: "Recipes",
    description: "Start from generated configs for common review workflows.",
    path: "recipes",
  },
  {
    title: "CLI reference",
    description: (
      <>
        Read the commands for init, check, inspect, review, and <InlineCode>pipr skill</InlineCode>.
      </>
    ),
    path: "reference/cli",
  },
] satisfies LandingLink[];

const repoUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

function Home() {
  return (
    <HomeLayout {...baseOptions()}>
      <main className="min-h-[calc(100vh-56px)] bg-fd-background text-fd-foreground">
        <div className="pipr-home-shell mx-auto flex w-full max-w-[53rem] flex-col px-6 py-12 sm:py-16 lg:py-20">
          <Hero />
          <InstallPanel />
          <ConceptCards />
          <MoreInfo />
          <Footer />
        </div>
      </main>
    </HomeLayout>
  );
}

function Hero() {
  return (
    <header>
      <div className="flex items-center justify-between gap-4">
        <h1 className="inline-flex items-center gap-3 text-3xl font-semibold tracking-normal text-fd-foreground">
          <img
            src="/images/pipr/pipr-mark-dark.svg"
            alt=""
            aria-hidden="true"
            className="size-8 shrink-0"
          />
          Pipr
        </h1>
        <a
          href={repoUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-9 shrink-0 items-center gap-2 rounded-md border border-fd-border px-3 text-sm font-medium text-fd-secondary-foreground transition-[background-color,color] hover:bg-fd-accent hover:text-fd-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fd-ring"
        >
          <HugeiconsIcon icon={GithubIcon} size={18} strokeWidth={1.8} aria-hidden="true" />
          GitHub
        </a>
      </div>
      <p className="mt-5 max-w-2xl font-mono text-sm leading-6 text-fd-muted-foreground">
        change request review runtime
      </p>
      <p className="pipr-heading pipr-text-pretty mt-8 max-w-2xl text-xl font-semibold leading-8 tracking-normal text-fd-foreground sm:text-2xl sm:leading-9">
        Repository-owned review policy, one validated runtime.
      </p>
      <p className="mt-4 max-w-2xl font-mono text-xs leading-5 text-fd-muted-foreground">
        GitHub · GitLab.com · Azure DevOps Services · Bitbucket Cloud
      </p>
    </header>
  );
}

function InstallPanel() {
  return (
    <section className="mt-10 min-w-0" aria-labelledby="install-heading">
      <div className="pipr-run-card min-w-0 overflow-hidden rounded-lg">
        <div className="p-4">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <SectionLabel id="install-heading">Install</SectionLabel>
            <CopyButton copyText={installCommand} label="Copy" />
          </div>
          <pre className="pipr-command-scrollbar mt-4 max-w-full overflow-x-auto whitespace-pre font-mono text-sm leading-7 text-fd-secondary-foreground">
            <code>
              {installCommandLines.map((line) => (
                <span key={line.id} className="block">
                  <span className="text-fd-primary">$</span> {line.command}
                </span>
              ))}
            </code>
          </pre>
          <div className="mt-3 flex min-w-0 items-center justify-between gap-3 border-t border-fd-border/80 pt-3">
            <div className="flex min-w-0 items-center gap-2 text-sm leading-6 text-fd-muted-foreground">
              <HugeiconsIcon
                icon={SparklesIcon}
                size={16}
                strokeWidth={1.8}
                className="shrink-0 text-fd-primary"
                aria-hidden="true"
              />
              <p className="min-w-0 truncate">
                <span className="pipr-heading font-semibold text-fd-foreground">
                  Using an agent?
                </span>{" "}
                <span className="hidden sm:inline">Copy the bundled Pipr skill prompt.</span>
              </p>
            </div>
            <CopyButton className="shrink-0" copyText={piprAgentSetupPrompt} label="Copy prompt" />
          </div>
        </div>
      </div>
    </section>
  );
}

function ConceptCards() {
  return (
    <section className="mt-14" aria-labelledby="what-pipr-does-heading">
      <div className="max-w-2xl">
        <SectionLabel>What Pipr is</SectionLabel>
        <h2
          id="what-pipr-does-heading"
          className="pipr-heading mt-4 text-xl font-semibold leading-8 text-fd-foreground"
        >
          One review runtime. Repository-owned policy.
        </h2>
      </div>
      <div className="mx-auto mt-6 grid max-w-[50rem] gap-4 md:grid-cols-2">
        {conceptCards.map((item) => (
          <article
            key={item.title}
            className={`min-w-0 overflow-hidden rounded-lg border p-4 ${item.cardClassName}`}
          >
            <div className="-mx-3 flex h-40 items-center justify-center overflow-hidden sm:h-48">
              <img
                src={item.image}
                alt=""
                aria-hidden="true"
                loading="lazy"
                decoding="async"
                className={`${item.imageClassName} object-contain`}
              />
            </div>
            <h3 className="pipr-heading mt-4 text-xl font-semibold leading-8 text-fd-foreground">
              {item.title}
            </h3>
            <p className="pipr-text-pretty mt-2 max-w-md text-sm leading-6 text-fd-secondary-foreground">
              {item.description}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}

function MoreInfo() {
  return (
    <section className="mt-14" aria-labelledby="more-info-heading">
      <SectionLabel id="more-info-heading">More information</SectionLabel>
      <div className="mt-4 border-y border-fd-border">
        {moreInfoLinks.map((item, index) => (
          <DocsLink
            key={item.path}
            path={item.path}
            className="group grid gap-3 border-b border-fd-border py-5 last:border-b-0 transition-[background-color] hover:bg-fd-muted/30 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-fd-ring sm:grid-cols-[3rem_11rem_1fr]"
          >
            <span className="font-mono text-xs text-fd-muted-foreground tabular-nums">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span className="inline-flex items-center gap-3 text-sm font-semibold text-fd-foreground">
              {item.title}
            </span>
            <span className="pipr-text-pretty text-sm leading-6 text-fd-muted-foreground transition-colors group-hover:text-fd-secondary-foreground">
              {item.description}
            </span>
          </DocsLink>
        ))}
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="mt-20 flex flex-wrap items-center justify-between gap-4 border-t border-fd-border pt-8 text-sm">
      <span className="font-mono text-xs uppercase tracking-[0.14em] text-fd-muted-foreground">
        Pipr
      </span>
      <nav
        className="ml-auto flex flex-wrap items-center justify-end gap-x-5 gap-y-2"
        aria-label="Footer"
      >
        <DocsLink
          path="guide"
          className="text-fd-muted-foreground transition-[color] hover:text-fd-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-fd-ring"
        >
          Docs
        </DocsLink>
        <a
          href={repoUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 text-fd-muted-foreground transition-[color] hover:text-fd-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-fd-ring"
        >
          <HugeiconsIcon icon={GithubIcon} size={16} strokeWidth={1.8} aria-hidden="true" />
          GitHub
        </a>
      </nav>
    </footer>
  );
}

function SectionLabel({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <p
      id={id}
      className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-fd-muted-foreground"
    >
      {children}
    </p>
  );
}

function InlineCode({ children }: { children: ReactNode }) {
  return <code className="pipr-inline-code">{children}</code>;
}

function DocsLink({
  path,
  className,
  children,
}: {
  path: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      to="/docs/$"
      params={{
        _splat: path,
      }}
      className={className}
    >
      {children}
    </Link>
  );
}
