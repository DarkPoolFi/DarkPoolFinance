import { createFileRoute } from "@tanstack/react-router";
import { DarkpoolPage } from "@/components/DarkpoolPage";
import { pageMeta } from "@/lib/page-meta";

export const Route = createFileRoute("/how-it-works")({
  head: () =>
    pageMeta(
      "How it works — DarkpoolFi",
      "Fund with USDG, place a sealed stock order, cross at one reference price, and withdraw through DarkpoolFi on Robinhood Chain.",
    ),
  component: () => <DarkpoolPage file="how-it-works.html" />,
});
