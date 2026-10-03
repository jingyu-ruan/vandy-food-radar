/**
 * One event card, server-rendered from the same `CardJson` the browser modules
 * render on every later date change (`public/static/js/cards.js`). The markup
 * and class names mirror that module exactly, so a first-paint card and a
 * client-rendered one are indistinguishable.
 *
 * Every value is rendered as a React text node; links reach `href` only after
 * `safeUrl` accepted them as absolute http(s) URLs in the view model.
 */

import { Fragment } from "react";
import { ActionIcon } from "./action-icon";
import { foodPresentation } from "@/public/static/js/food-presentation.js";

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
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function PlaceFact({ card }: { card: CardJson }) {
  if (card.place) {
    return (
      <Fact label="Place">
        <span className="fact-strong">{card.place.name}</span>
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
        <span className="fact-strong">{card.location_listed}</span>{" "}
        <span className="fact-muted">not matched to a campus building</span>
      </Fact>
    );
  }
  return (
    <Fact label="Place">
      <span className="fact-muted">Not listed</span>
    </Fact>
  );
}

export function WorkspaceCard({ card }: { card: CardJson }) {
  const food = foodPresentation(card);
  const stars = Math.max(0, Math.min(5, card.stars));
  return (
    <article
      className={`card is-${card.state}`}
      data-identity-key={card.identity_key}
      data-date={card.date}
      {...(card.place ? { "data-lat": card.place.lat, "data-lng": card.place.lng } : {})}
    >
      <header className="card-top">
        <h3 className="card-title">{card.title}</h3>
        <span
          className="stars"
          role="img"
          aria-label={`Recommendation ${stars} of 5`}
          title={`Recommendation ${stars} of 5`}
        >
          {Array.from({ length: 5 }, (_, index) => (
            <i key={index} className={`star ${index < stars ? "on" : "off"}`} aria-hidden="true" />
          ))}
        </span>
      </header>

      <p className="card-when">
        <span className="when-time">{card.time_label}</span>
        {card.badge ? <span className="tag tag-alert">{card.badge}</span> : null}
        {card.change ? <span className="tag tag-change">{card.change}</span> : null}
      </p>

      <dl className="card-facts">
        <Fact label="Food">
          <span className={`chip chip-${food.tone}`}>{food.label}</span>
          {food.detail ? <span className="food-note">{food.detail}</span> : null}
          {card.food_description ? (
            <span className="fact-text">{card.food_description}</span>
          ) : null}
        </Fact>
        <PlaceFact card={card} />
        {card.place && card.location_listed ? (
          <Fact label="Listed as">
            <span className="fact-text">{card.location_listed}</span>
          </Fact>
        ) : null}
        <Fact label="Walk">
          <span className="fact-text" data-role="walking">
            {card.walking_label}
          </span>
        </Fact>
        {card.rsvp_label !== "RSVP not stated" || card.rsvp_url ? (
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
          <span className="fact-text">{card.organizer || "Not listed"}</span>
        </Fact>
        <Fact label="Participation" wide>
          <span className="fact-text">{card.participation.note}</span>
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
        <button
          type="button"
          className="action action-save icon-button"
          aria-label={`Save ${card.title}`}
          title={`Save ${card.title}`}
          data-action="toggle-save"
          aria-pressed="false"
        >
          <ActionIcon name="star" />
        </button>
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
