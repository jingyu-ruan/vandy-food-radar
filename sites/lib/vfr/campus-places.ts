/**
 * The bundled campus dataset.
 *
 * The browser downloads `public/static/campus-places.json` for the origin
 * combobox; the server imports the very same file at build time to resolve
 * listed locations, so the two can never disagree about a building.
 */

import payload from "../../public/static/campus-places.json" with { type: "json" };
import { parsePlaces } from "./places.ts";
import type { PlaceDataset } from "./places.ts";

let cached: PlaceDataset | null = null;

/** The parsed, validated dataset (parsed once per isolate). */
export function campusPlaces(): PlaceDataset {
  cached ??= parsePlaces(payload as unknown);
  return cached;
}
