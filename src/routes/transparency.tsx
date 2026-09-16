import { createFileRoute } from "@tanstack/react-router";
import { DarkpoolPage } from "@/components/DarkpoolPage";
import { pageMeta } from "@/lib/page-meta";

export const Route = createFileRoute("/transparency")({
  head: () =>
    pageMeta(
      "Transparency — DarkpoolFi",
      "DarkpoolFi’s privacy boundaries, screened deposits, delayed tape, execution limits, and Robinhood Chain context.",
    ),
  component: () => <DarkpoolPage file="transparency.html" script="/transparency.js" />,
});
