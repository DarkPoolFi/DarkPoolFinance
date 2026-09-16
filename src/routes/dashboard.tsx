import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { DarkpoolPage } from "@/components/DarkpoolPage";
import { pageMeta } from "@/lib/page-meta";

declare global {
  interface Window {
    darkpoolShieldedReady?: Promise<typeof import("@/shielded/client")>;
  }
}

function Dashboard() {
  // The shielded client (bb.js + noir WASM) loads only on the dashboard; public/shielded.js awaits it.
  useEffect(() => {
    window.darkpoolShieldedReady ??= import("@/shielded/client");
  }, []);
  return <DarkpoolPage file="dashboard.html" dashboard script="/shielded.js" />;
}

export const Route = createFileRoute("/dashboard")({
  head: () =>
    pageMeta(
      "Dashboard — DarkpoolFi",
      "Private USDG funding and sealed stock execution on Robinhood Chain. Interactive preview.",
    ),
  component: Dashboard,
});
