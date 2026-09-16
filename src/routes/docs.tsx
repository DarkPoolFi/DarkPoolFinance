import { createFileRoute } from "@tanstack/react-router";
import { DarkpoolPage } from "@/components/DarkpoolPage";
import { pageMeta } from "@/lib/page-meta";

export const Route = createFileRoute("/docs")({
  head: () =>
    pageMeta(
      "Docs — DarkpoolFi",
      "How DarkpoolFi works: the shielded pool, sealed orders, crossing windows, fees, privacy and the dashboard on Robinhood Chain.",
    ),
  component: () => <DarkpoolPage file="docs.html" />,
});
