/**
 * One dense ranked event card.
 *
 * Everything shown is read from the published feed. Text that originated in the
 * source description is rendered as a React text node, so the HTML that arrived
 * from AnchorLink is already reduced to plain text and cannot re-enter the page
 * as markup. There is no `dangerouslySetInnerHTML` anywhere in this app.
 *
 * Unknowns are stated, not filled in: an RSVP requirement the source never
 * declared reads "RSVP unknown", and a walking time nobody can compute reads
 * "Walking time unavailable".
 */

import {
  AGREEMENT_LABELS,
  CHANGE_LABELS,
  FACTOR_LABELS,
  FIELD_LABELS,
  FOOD_CATEGORY_LABELS,
  FOOD_LABELS,
  SOURCE_LABELS,
  STATE_LABELS,
  formatRsvp,
  formatTimeRange,
} from "@/lib/vfr/labels.ts";
import { ChangeKind, VerificationState } from "@/lib/vfr/models.ts";
import type { StoredEvent } from "@/lib/vfr/repository.ts";

function formatScore(value: number | null): string {
  return value === null ? "—" : value.toFixed(2);
}

function formatProvenanceValue(value: unknown): string {
  if (value === null || value === undefined) return "not provided";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string") return value || "not provided";
  return JSON.stringify(value);
}

export function EventCard({ stored }: { stored: StoredEvent }) {
  const { event } = stored;
  const stateClass = `vfr-state-${event.verificationState}`;
  const changeKind = stored.change?.kind ?? null;
  const changeLabel =
    changeKind !== null && changeKind !== ChangeKind.UNCHANGED
      ? CHANGE_LABELS[changeKind]
      : null;
  const isCancelled = event.verificationState === VerificationState.CANCELLED;

  return (
    <li className={`vfr-card ${stateClass}`}>
      <div className="vfr-card-head">
        <span className="vfr-rank" aria-label={`Rank ${stored.rank}`}>
          {stored.rank}
        </span>
        <h2 className="vfr-title">{event.title}</h2>
        <span className={`vfr-badge ${stateClass}`}>
          {STATE_LABELS[event.verificationState]}
        </span>
        {changeLabel ? (
          <span className={`vfr-change vfr-change-${changeKind}`}>{changeLabel}</span>
        ) : null}
        <span className="vfr-score" title="Ranking score out of 1.00">
          {formatScore(event.scoreTotal)}
        </span>
      </div>

      <dl className="vfr-facts">
        <div>
          <dt>Date</dt>
          <dd>{event.eventDate}</dd>
        </div>
        <div>
          <dt>Time</dt>
          <dd>{formatTimeRange(event)}</dd>
        </div>
        <div>
          <dt>Location</dt>
          <dd>{event.location ?? "Location to be announced"}</dd>
        </div>
        <div>
          <dt>Organizer</dt>
          <dd>{event.organizer ?? "Organizer not listed"}</dd>
        </div>
        <div>
          <dt>RSVP</dt>
          <dd>{formatRsvp(event)}</dd>
        </div>
        <div>
          <dt>Walking</dt>
          <dd>{stored.walkingLabel}</dd>
        </div>
        <div className="vfr-food">
          <dt>Food</dt>
          <dd>
            <span className="vfr-chip">{FOOD_LABELS[event.foodConfirmed]}</span>
            <span className="vfr-chip">
              {FOOD_CATEGORY_LABELS[event.foodCategory] ?? event.foodCategory}
            </span>
            {event.foodDescription ?? "No description provided"}
          </dd>
        </div>
      </dl>

      <p className="vfr-explanation">{stored.explanation}</p>

      {stored.change?.detail ? (
        <p className="vfr-change-detail">Changed since the last update: {stored.change.detail}</p>
      ) : null}

      <div className="vfr-actions">
        {event.eventUrl ? (
          <a
            className="vfr-link"
            href={event.eventUrl}
            rel="noreferrer noopener"
            target="_blank"
          >
            View on AnchorLink
          </a>
        ) : null}
        {!isCancelled && event.anchorlinkId ? (
          <a
            className="vfr-download"
            href={`/api/calendar/${event.anchorlinkId}`}
            download
          >
            Download calendar file
          </a>
        ) : null}
      </div>

      <details className="vfr-details">
        <summary>Score factors</summary>
        <table className="vfr-factor-table">
          <thead>
            <tr>
              <th scope="col">Factor</th>
              <th scope="col">Value</th>
              <th scope="col">Weight</th>
              <th scope="col">Contribution</th>
              <th scope="col">Why</th>
            </tr>
          </thead>
          <tbody>
            {stored.components.map((component) => (
              <tr key={component.factor}>
                <th scope="row">
                  {FACTOR_LABELS[component.factor] ?? component.factor}
                </th>
                <td>{component.rawValue.toFixed(2)}</td>
                <td>{component.weight.toFixed(2)}</td>
                <td>{component.contribution.toFixed(3)}</td>
                <td>{component.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <details className="vfr-details">
        <summary>Where this came from</summary>
        <ul className="vfr-provenance">
          {stored.sources.map((source) => (
            <li key={`${source.sourceId}-${source.sourceUrl ?? ""}`}>
              <strong>{SOURCE_LABELS[source.sourceId] ?? source.sourceId}</strong>
              {source.sourceUrl ? (
                <>
                  {" — "}
                  <a href={source.sourceUrl} rel="noreferrer noopener" target="_blank">
                    {source.sourceUrl}
                  </a>
                </>
              ) : null}
              {source.checkedAt ? <span> (checked {source.checkedAt})</span> : null}
            </li>
          ))}
          {stored.provenance.map((entry) => (
            <li key={entry.fieldName}>
              <strong>{FIELD_LABELS[entry.fieldName] ?? entry.fieldName}</strong>
              {": "}
              {formatProvenanceValue(entry.chosenValue)}
              {" — "}
              {AGREEMENT_LABELS[entry.agreement] ?? entry.agreement}
            </li>
          ))}
        </ul>
        {event.confidence !== null ? (
          <p className="vfr-confidence">
            Confidence {event.confidence.toFixed(2)}. Only one source lists this event, so
            it can be partially verified at best.
          </p>
        ) : null}
      </details>

      {stored.conflicts.length > 0 ? (
        <details className="vfr-details vfr-conflicts">
          <summary>
            {stored.conflicts.length} conflicting detail
            {stored.conflicts.length === 1 ? "" : "s"}
          </summary>
          <ul>
            {stored.conflicts.map((conflict) => (
              <li key={conflict.fieldName}>
                <strong>{FIELD_LABELS[conflict.fieldName] ?? conflict.fieldName}</strong>
                {": "}
                {conflict.competingValues
                  .map(
                    (competing) =>
                      `${SOURCE_LABELS[competing.sourceId] ?? competing.sourceId}: ${formatProvenanceValue(competing.value)}`,
                  )
                  .join("; ")}
                {conflict.resolution ? <em> ({conflict.resolution})</em> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {stored.history.length > 0 ? (
        <details className="vfr-details">
          <summary>Recent changes to this event</summary>
          <ul>
            {stored.history.slice(0, 8).map((entry) => (
              <li key={`${entry.changedAt}-${entry.fieldName}`}>
                {FIELD_LABELS[entry.fieldName] ?? entry.fieldName}:{" "}
                {entry.oldValue ?? "not set"} → {entry.newValue ?? "not set"}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}
