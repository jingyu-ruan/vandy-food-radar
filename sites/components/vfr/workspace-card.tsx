import {hostEventId,hostPanelId} from '@/public/static/js/host.js';
import {foodDescriptionText} from "@/public/static/js/food-emoji.js";
/**
 * One event card, server-rendered from the same `CardJson` the browser modules
 * render on every later date change (`public/static/js/cards.js`). The markup
 * and class names mirror that module exactly, so a first-paint card and a
 * client-rendered one are indistinguishable.
 *
 * Every value is rendered as a React text node; links reach `href` only after
 * `safeUrl` accepted them as absolute http(s) URLs in the view model.
 */

import {eventAnchor, participationText} from "@/public/static/js/brief.js";
import { Fragment } from "react";
import { ActionIcon } from "./action-icon";
import { foodPresentation } from "@/public/static/js/food-presentation.js";
import { ratingPresentation } from "@/public/static/js/rating.js";
import { FACT_ICONS } from "@/public/static/js/fact-icons.js";
import { destinationFor, googleWalkingUrl } from "@/public/static/js/maps-links.js";

import type { CardJson } from "@/lib/vfr/viewmodel.ts";

function Fact({
  label,
  wide = false,
  children,
}: {
  label: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={wide ? "fact fact-wide" : "fact"}>
      <dt><ActionIcon name={FACT_ICONS[label as keyof typeof FACT_ICONS] || "info"} /><span>{label}</span></dt>
      <dd>{children}</dd>
    </div>
  );
}

type WalkingOrigin = { label: string; lat: number; lng: number };

function PlaceFact({ card, origin }: { card: CardJson; origin: WalkingOrigin }) {
  const destination = destinationFor(card);
  const url = googleWalkingUrl(origin, destination);
  const name = card.place?.name || card.location_listed;
  const placeName = url ? (
    <a className="fact-strong place-link" href={url} target="_blank" rel="noopener noreferrer"
      data-role="place-directions" data-destination-address={destination?.address || ""}
      aria-label={`Walking directions to ${name} in Google Maps`}>{name}</a>
  ) : <span className="fact-strong">{name}</span>;
  if (card.place) {
    return (
      <Fact label="Place">
        {placeName}
        {card.place.detail ? (
          <>
            {" "}
            <span className="fact-text">{card.place.detail}</span>
          </>
        ) : null}
      </Fact>
    );
  }
  if (card.location_listed) {
    return (
      <Fact label="Place">
        {placeName}{" "}
        <span className="chip chip-quiet">Unmapped</span>
      </Fact>
    );
  }
  return (
    <Fact label="Place">
      <span className="chip chip-quiet">Not Listed</span>
    </Fact>
  );
}

export function WorkspaceCard({ card, origin }: { card: CardJson; origin: WalkingOrigin }) {
  const food = foodPresentation(card);
  const rating = ratingPresentation(card);
  return (
    <article
      className={`card is-${card.state}`}
      id={eventAnchor(card.identity_key)}
      tabIndex={-1}
      data-identity-key={card.identity_key}
      data-date={card.date}
      {...(card.place ? { "data-lat": card.place.lat, "data-lng": card.place.lng } : {})}
    >
      <header className="card-top">
        <h3 className="card-title">{card.event_url ? <a href={card.event_url} target="_blank" rel="noopener noreferrer">{card.title}</a> : card.title}</h3>
        <div className="rating">
          <button type="button" className="rating-trigger" data-action="toggle-rating" aria-label={`Rating ${rating.score} of 5. Show score breakdown for ${card.title}`} aria-expanded="false" aria-controls={rating.id}><span>Rating</span><span className="rating-score">{rating.score} / 5.0</span></button>
          <div className="rating-panel" id={rating.id} role="region" aria-label={`Rating breakdown for ${card.title}`} tabIndex={0} hidden>
            <p className="rating-total">Total Score: {rating.total}</p>
            {rating.rows.length ? <table><thead><tr><th>Factor</th><th>Weight</th><th>Value</th><th>Points</th></tr></thead><tbody>{rating.rows.map((row, index) => <Fragment key={index}><tr><th scope="row"><span>{row.label}</span><span className="rating-factor-note">{row.note}</span></th><td>{row.weight}</td><td>{row.value}</td><td>{row.points}</td></tr></Fragment>)}</tbody></table> : <p>Score breakdown is unavailable for this published event.</p>}
            <p className="rating-context">{rating.scale} {rating.context}</p>
          </div>
        </div>
      </header>

      <p className="card-when">
        <span className="when-time">{card.time_label}</span>
        {card.badge ? <span className="tag tag-alert">{card.badge}</span> : null}
        {card.change ? <span className="tag tag-change">{card.change}</span> : null}
      </p>

      <dl className="card-facts">
        <Fact label="Food">
          <span className={`chip chip-${food.tone}`}>{food.label}</span>
          {food.detail ? <span className="chip chip-quiet">{food.detail}</span> : null}
          {foodDescriptionText(card) ? (
            <span className="fact-text">{foodDescriptionText(card)}</span>
          ) : null}
        </Fact>
        <PlaceFact card={card} origin={origin} />
        {card.place && card.location_listed ? (
          <Fact label="Listed As">
            <span className="fact-text">{card.location_listed}</span>
          </Fact>
        ) : null}
        <Fact label="Walk">
          <span className="fact-text" data-role="walking">
            {card.walking_label}
          </span>
        </Fact>
        {card.rsvp_label !== "RSVP Not Stated" || card.rsvp_url ? (
          <Fact label="RSVP">
            {card.rsvp_url ? (
              <a
                className="fact-link"
                href={card.rsvp_url}
                rel="noopener noreferrer"
                target="_blank"
              >
                {card.rsvp_label}
              </a>
            ) : (
              <span className="fact-text">{card.rsvp_label}</span>
            )}
          </Fact>
        ) : null}
        <Fact label="Host">
          {card.organizer && hostEventId(card.event_url) ? <span className="host-profile" data-event-id={hostEventId(card.event_url)}><button type="button" className="host-trigger" aria-expanded="false" aria-controls={hostPanelId(card)} aria-label={`About ${card.organizer}`}>{card.organizer}</button><span className="host-panel" id={hostPanelId(card)} role="region" aria-label={`Host introduction for ${card.organizer}`} hidden><span className="host-description">Loading introduction…</span></span></span> : <span className="fact-text">{card.organizer || "Not Listed"}</span>}
        </Fact>
        <Fact label="Participation" wide>
          <span className="fact-text" title={card.participation.ai_evidence ? `Source: ${card.participation.ai_evidence}` : undefined}>{participationText(card.participation)}</span>
        </Fact>
      </dl>

      {card.warnings.length ? (
        <ul className="card-warnings">
          {card.warnings.map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
      ) : null}

      <footer className="card-actions">
        {!card.cancelled ? (
          <details className="calendar-menu">
            <summary className="action"><ActionIcon name="calendar" /><span>Calendar</span></summary>
            <div className="calendar-options">
              {card.calendar.google ? (
                <a
                  className="action"
                  href={card.calendar.google}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  Google Calendar
                </a>
              ) : null}
              {card.calendar.ics ? (
                <a className="action" href={card.calendar.ics}>
                  Download .ics
                </a>
              ) : null}
            </div>
          </details>
        ) : null}
        {card.event_url ? (
          <a className="action" href={card.event_url} rel="noopener noreferrer" target="_blank">
            <ActionIcon name="external-link" /><span>Source</span>
          </a>
        ) : null}
        <button type="button" className="action" data-action="toggle-details" aria-expanded="false">
          <ActionIcon name="info" /><span data-role="action-label">Details</span>
        </button>
        <button
          type="button"
          className="action action-save"
          aria-label={`Save ${card.title}`}
          title={`Save ${card.title}`}
          data-action="toggle-save"
          aria-pressed="false"
        >
          <ActionIcon name="star" /><span data-role="save-label">Save</span>
        </button>
      </footer>

      <div className="card-details" hidden>
        {card.description ? <p className="detail-description">{card.description}</p> : null}
        <p className="detail-why">{card.explanation}</p>
        {card.sources.length ? (
          <p className="detail-sources">
            {card.sources.map((source, index) => (
              <Fragment key={source.url}>
                <a href={source.url} rel="noopener noreferrer" target="_blank">
                  {source.label}
                </a>
                {index < card.sources.length - 1 ? <span className="sep"> </span> : null}
              </Fragment>
            ))}
          </p>
        ) : null}
        {card.conflicts.length ? (
          <ul className="detail-conflicts">
            {card.conflicts.map((conflict, index) => (
              <li key={index}>
                <strong>{conflict.field}</strong> <span>{conflict.values.join("; ")}</span>
                {conflict.resolution ? (
                  <>
                    {" "}
                    <em>{conflict.resolution}</em>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </article>
  );
}
