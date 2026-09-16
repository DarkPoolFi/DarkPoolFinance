import { createFileRoute } from "@tanstack/react-router";
import { DarkpoolPage } from "@/components/DarkpoolPage";
import { pageMeta } from "@/lib/page-meta";

export const Route = createFileRoute("/execution")({
  head: () =>
    pageMeta(
      "Execution — DarkpoolFi",
      "Understand DarkpoolFi’s fixed crosses, optional limits, wait-or-cancel policies, and full, partial, unfilled, or skipped outcomes.",
    ),
  component: () => <DarkpoolPage file="execution.html" />,
});
