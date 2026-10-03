# Vandy Food Radar icons — Claude Sonnet 5 (Kiro CLI), QA revision

Design model: **Claude Sonnet 5 (generated via Kiro CLI)**.

## Why this revision exists

The prior pass used a filled V with flat horizontal "shoulder" tops, fork
tines that started close enough to the radar arc to touch it, and a favicon
spoon ellipse that overlapped the discovery dot. This revision keeps the same
heavier filled-V direction, palette, and 64-unit canvas, and corrects those
three issues with specific geometry changes, listed below with the
measurements that back them.

## V-shape construction

The V is a single filled path (no stroke), so each segment's width is set
directly instead of depending on a uniform stroke weight. The original Codex
version used a stroke of `stroke-width="4.6"`; this filled path keeps the
shoulders at **7 units wide** (`24.6 − 17.6 = 7` on the left leg, `46.4 − 39.4
= 7` on the right) and the two legs taper to a shared rounded apex.

The apex is built from two cubic Bézier curves (`C` commands) rather than the
two legs meeting at a point, so the bottom of the V reads as one small rounded
form rather than a sharp vertex. In the previous Codex stroke version the two
strokes met at a mitered corner; its `stroke-linejoin` was `round`, which
rounds convex corners along the stroke outline but does not change how the
two strokes converge at the tip, so that version still showed a pointed
vertex. The filled apex in this version has no equivalent sharp point.

## Fork tines: gap from the radar arc

The radar arc is a circular arc of radius 24 centered at (32, 32) (stroke
width 2.6, 80% opacity). In the previous revision the fork tine rectangles
started at `y="12.2"`, and the top-left corner of the left tine, (18.4, 12.2),
sits at a distance of approximately 24.0 units from the arc's center — on the
arc itself, with no visible gap.

The tines now start at `y="14.9"` (height reduced from 9.6 to 6.9, bottom
edge unchanged at `y=21.8` so the connecting web between the tines is
unaffected). The same top-left corner, (18.4, 14.9), is now about 21.9 units
from the arc's center, leaving a gap of roughly 2 units between the fork tips
and the arc. Both tine rectangles share the same `y` and height, so the tips
stay level with each other.

## Favicon: spoon ellipse removed

In the 32-unit favicon, the spoon ellipse was centered at (21.6, 7.6) with
`rx="2.2"`, and the discovery dot was centered at (25.5, 8) with `r="2.3"`.
The distance between those two centers is about 3.9 units, which is less than
the sum of the ellipse's horizontal radius and the dot's radius (4.5 units),
so the two shapes overlapped by roughly half a unit.

The spoon ellipse has been removed from the favicon. The favicon now shows
only the background square, the arc, the discovery dot, and the filled V,
which is the only utensil shape rendered at this size. With the ellipse gone,
the dot has clear space around it: the nearest edge of the V (the filleted
top-right corner, at approximately (23.08, 12.13)) is roughly 3 units from
the dot's center, well outside the dot's 2.3-unit radius.

## Shoulder-to-utensil transitions

The flat horizontal shoulder tops (7 units wide) previously met the diagonal
outer leg edges at a sharp 90° corner, which showed as a small flat ledge
below where the fork and spoon sit. Each of those two corners is now
filleted with a quadratic curve (radius 1.6 units in the icon and mark, 0.8
units in the favicon, matching its half-scale geometry): the path approaches
the corner along the outer diagonal edge, curves through the original corner
position as the curve's control point, and rejoins the horizontal top a
short distance in. The horizontal top width and the leg taper down to the
apex are otherwise unchanged, so the shoulders keep the same 7-unit width and
the legs keep the same heavier weight; only the corner where the top edge
meets the outer edge is rounded.

## Spoon bowl: gap from the radar arc

The icon and mark's spoon ellipse is now centered at (43.6, 19.8) with
`rx="4.6"`, `ry="6.4"` (previously centered at (43.6, 18.4) with `ry="7.0"`).
The ellipse's topmost point, (43.6, 13.4), is about 21.9 units from the arc's
center (32, 32), leaving a gap of roughly 2 units from the arc, matching the
fork side. The bottom of the ellipse still extends slightly past the leg's
shoulder line, which is the intended overlap that lets the bowl's curve blend
into the leg rather than sit as a separate floating shape.

## Discovery point

The discovery point sits in the open quadrant of the arc in all three files.
In the icon and mark, its center (53, 11) is about 12.9 units from the spoon
ellipse's center and about 1.1 units clear of the arc's outer edge. In the
favicon, its center (25.5, 8) is about 1 unit clear of the arc's inner edge,
and, with the spoon ellipse removed, has no other shape nearby.

## File list

- `kiro-icon.svg` — 64×64, rounded-square background, filled V with filleted
  shoulders, fork, spoon, radar arc, and discovery point.
- `kiro-favicon.svg` — 32×32, simplified: filled V, radar arc, and discovery
  point only (no spoon ellipse).
- `kiro-mark.svg` — 64×64, transparent background, dark V/fork/spoon with a
  gold discovery point, same geometry as the icon.
- `design-notes.md` — this file.
