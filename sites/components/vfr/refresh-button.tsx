"use client";

/**
 * Refresh control.
 *
 * Issues `POST /api/refresh` and reports the three states a refresh can be in.
 * The failure message distinguishes an authorization problem, a source outage,
 * and a storage problem, because the user's next action differs in each case.
 *
 * On success the page is reloaded so the newly published feed is read back from
 * durable storage. The button never renders events from its own response.
 */

import { useState, useTransition } from "react";

type Status =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

export function RefreshButton() {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [isReloading, startReload] = useTransition();

  const busy = status.kind === "pending" || isReloading;

  async function onRefresh() {
    setStatus({ kind: "pending" });
    try {
      const response = await fetch("/api/refresh", {
        method: "POST",
        headers: { accept: "application/json" },
      });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string; published?: number; targetDate?: string }
        | null;

      if (response.ok && payload?.ok) {
        const count = payload.published ?? 0;
        setStatus({
          kind: "success",
          message:
            count > 0
              ? `Updated: ${count} event${count === 1 ? "" : "s"} published.`
              : "Updated: the source listed no matching events for this date.",
        });
        startReload(() => {
          window.location.reload();
        });
        return;
      }

      const fallback =
        response.status === 401 || response.status === 403
          ? "Not authorized to refresh."
          : response.status === 409
            ? "Another refresh is already running. Try again shortly."
            : "Refresh failed. The previously published listing is still shown.";
      setStatus({ kind: "error", message: payload?.error ?? fallback });
    } catch {
      setStatus({
        kind: "error",
        message: "Could not reach the server. The listing below is unchanged.",
      });
    }
  }

  return (
    <div className="vfr-refresh">
      <button
        type="button"
        className="vfr-refresh-btn"
        onClick={onRefresh}
        disabled={busy}
        aria-busy={busy}
      >
        {busy ? "Refreshing\u2026" : "Refresh events"}
      </button>
      <p
        className={`vfr-refresh-status vfr-refresh-${status.kind}`}
        role="status"
        aria-live="polite"
      >
        {status.kind === "pending"
          ? "Fetching the latest listing\u2026"
          : status.kind === "success" || status.kind === "error"
            ? status.message
            : ""}
      </p>
    </div>
  );
}
