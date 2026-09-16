import { createFileRoute } from "@tanstack/react-router";
import { DarkpoolPage } from "@/components/DarkpoolPage";
import { pageMeta } from "@/lib/page-meta";

export const Route = createFileRoute("/legal/terms-of-service")({
  head: () => pageMeta("Terms of Service — DarkpoolFi", "DarkpoolFi preview terms of service."),
  component: () => <DarkpoolPage file="legal-terms-of-service.html" />,
});
