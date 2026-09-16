import { useEffect } from "react";

const pages = import.meta.glob("../pages/*.html", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

let initialized = false;

/**
 * Renders an original DarkpoolFi page body untouched and boots its controllers
 * after mount. Navigation between pages uses plain anchors (full document
 * loads) so the original page wipes and in-memory preview resets are kept.
 */
export function DarkpoolPage({ file, dashboard = false, script }: { file: string; dashboard?: boolean; script?: string }) {
  const markup = pages[`../pages/${file}`] ?? "";

  useEffect(() => {
    if (initialized) return;
    initialized = true;
    const load = (src: string, module = false) =>
      new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = src;
        script.async = false;
        if (module) script.type = "module";
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Unable to load ${src}`));
        document.body.append(script);
      });

    void (async () => {
      await load("/i18n.js"); // first: translates the page before the controllers render into it
      await load("/preloader.js");
      await load("/app.js");
      await load("/motion.js");
      await load("/effects.js", true);
      if (dashboard) await load("/dashboard.js", true);
      if (script) await load(script, true);
    })().catch(console.error);
  }, [dashboard, script]);

  return <div id="site-document" style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: markup }} />;
}
