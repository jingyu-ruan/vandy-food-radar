"use client";

/**
 * Owner refresh control.
 *
 * Issues `POST /api/refresh?days=2` (today and tomorrow, the dates people act
 * on) and reports the outcome. On success the page reloads so the newly
 * published feed is read back from durable storage; the button never renders
 * events from its own response. The scheduled refresh covers the full week.
 */

import { useState } from "react";

type Status =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

export function RefreshButton() {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const busy = status.kind === "pending" || status.kind === "success";

  async function onRefresh() {
    setStatus({ kind: "pending" });
    try {
      const response = await fetch("/api/refresh?days=2", {
        method: "POST",
        headers: { accept: "application/json" },
        credentials: "same-origin",
      });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string; published?: number }
        | null;

      if (response.ok && payload?.ok) {
        setStatus({ kind: "success", message: "Updated. Reloading\u2026" });
        window.location.reload();
        return;
      }

      const fallback =
        response.status === 401 || response.status === 403
          ? "Not authorized to refresh."
          : response.status === 409
            ? "A refresh is already running. Try again shortly."
            : "Refresh failed; the published listing was kept.";
      setStatus({ kind: "error", message: payload?.error ?? fallback });
    } catch {
      setStatus({ kind: "error", message: "Could not reach the server." });
    }
  }

  return (
    <>
      <button
        type="button"
        className="control-button"
        onClick={onRefresh}
        disabled={busy}
        aria-busy={busy}
      >
        {status.kind === "pending" ? "Refreshing\u2026" : "Refresh now"}
      </button>
      <p className="side-status" role="status" aria-live="polite">
        {status.kind === "success" || status.kind === "error" ? status.message : ""}
      </p>
    </>
  );
}
