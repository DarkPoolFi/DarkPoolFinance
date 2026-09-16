import { createFileRoute } from "@tanstack/react-router";
import { DarkpoolPage } from "@/components/DarkpoolPage";
import { pageMeta } from "@/lib/page-meta";

export const Route = createFileRoute("/legal/risk-disclosure")({
  head: () => pageMeta("Risk Disclosure — DarkpoolFi", "DarkpoolFi preview risk disclosure."),
  component: () => <DarkpoolPage file="legal-risk-disclosure.html" />,
});
