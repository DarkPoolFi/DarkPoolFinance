import { createFileRoute } from "@tanstack/react-router";
import { DarkpoolPage } from "@/components/DarkpoolPage";
import { pageMeta } from "@/lib/page-meta";

export const Route = createFileRoute("/")({
  head: () =>
    pageMeta(
      "Privacy in every order — DarkpoolFi",
      "DarkpoolFi brings sealed stock orders, shared crossing windows and private USDG funding to Robinhood Chain.",
      "https://darkpoolfi.tech/assets/darkpool-hero-social.png",
    ),
  component: () => <DarkpoolPage file="home.html" />,
});
