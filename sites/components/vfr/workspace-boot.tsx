"use client";

/**
 * Starts the workspace's browser modules once React has hydrated the page.
 *
 * The cards, schedule, map, origin, and itinerary behavior are the plain ES
 * modules under `public/static/js/`, shared verbatim with the Python reference.
 * They take over regions that the server already rendered, so they are loaded
 * from an effect: by then hydration has finished and React will not reconcile
 * the regions the modules re-render. Nothing here renders markup.
 */

import { useEffect } from "react";

const ENTRY = "/static/js/main.js";

export function WorkspaceBoot() {
  useEffect(() => {
    // Public assets are served unchanged. Load through an HTML module tag so
    // Vite never tries to transform this public file as an application import.
    const script = document.createElement("script");
    script.type = "module";
    script.src = ENTRY;
    script.onerror = () => {
      console.error("workspace modules could not be loaded");
      const brief = document.querySelector('[data-role="brief-text"]');
      if (brief) {
        brief.textContent = "Interactive views could not be loaded.";
      }
    };
    document.body.appendChild(script);
    return () => { script.remove(); };
  }, []);
  return null;
}
