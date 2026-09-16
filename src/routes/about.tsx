import { createFileRoute } from "@tanstack/react-router";
import { DarkpoolPage } from "@/components/DarkpoolPage";
import { pageMeta } from "@/lib/page-meta";

export const Route = createFileRoute("/about")({
  head: () =>
    pageMeta(
      "About — DarkpoolFi",
      "Meet DarkpoolFi: sealed stock execution, private USDG balances, and one shared crossing window on Robinhood Chain.",
    ),
  component: () => <DarkpoolPage file="about.html" />,
});
