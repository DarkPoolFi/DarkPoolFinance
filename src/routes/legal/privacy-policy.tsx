import { createFileRoute } from "@tanstack/react-router";
import { DarkpoolPage } from "@/components/DarkpoolPage";
import { pageMeta } from "@/lib/page-meta";

export const Route = createFileRoute("/legal/privacy-policy")({
  head: () => pageMeta("Privacy Policy — DarkpoolFi", "DarkpoolFi preview privacy policy."),
  component: () => <DarkpoolPage file="legal-privacy-policy.html" />,
});
