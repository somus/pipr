import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { appName, gitConfig } from "./shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      // JSX supported
      title: (
        <span className="inline-flex items-center gap-2 font-semibold">
          <img
            src="/images/pipr/pipr-mark-light.svg"
            alt=""
            aria-hidden="true"
            className="size-7 shrink-0 dark:hidden"
          />
          <img
            src="/images/pipr/pipr-mark-dark.svg"
            alt=""
            aria-hidden="true"
            className="hidden size-7 shrink-0 dark:block"
          />
          <span>{appName}</span>
        </span>
      ),
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
