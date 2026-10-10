/**
 * The world is a fixed coordinate space. (0, 0) is the centre of the map — the
 * point the camera starts on, where the name lockup sits.
 *
 * Coordinates below are authored against a 1440x1024 reference viewport. At
 * smaller breakpoints every position and size is multiplied by `worldScale()`,
 * which makes the whole world contract around the centre so the islands stay
 * reachable on a phone without changing their relative arrangement.
 */

export type IslandKind = "phones" | "browser" | "art-box" | "art-bonno";

export interface Island {
  slug: string;
  /** Short label shown in the waypoint pill. */
  label: string;
  title: string;
  tagline: string;
  year: string;
  role: string;
  kind: IslandKind;
  /** Drives the waypoint pill, the minimap swatch and the detail page accent. */
  color: string;
  /** Centre of the island, in world units. */
  x: number;
  y: number;
  /** Size of the island, in world units, at scale 1. */
  w: number;
  h: number;
  images: string[];
}

export const ISLANDS: Island[] = [
  {
    slug: "ray",
    label: "Ray.",
    title: "Ray",
    tagline: "A reading app that gets out of the way.",
    year: "2025",
    role: "Design + iOS",
    kind: "phones",
    color: "#f4a3a3",
    x: -774,
    y: -136,
    w: 566,
    h: 342,
    images: ["/ray-2.webp", "/ray-3.webp", "/ray-1.webp"],
  },
  {
    slug: "tastify",
    label: "Tastify",
    title: "Tastify",
    tagline: "Showcase your music taste, easily.",
    year: "2024",
    role: "Design + full stack",
    kind: "browser",
    color: "#bce88c",
    x: 315,
    y: -519,
    w: 357,
    h: 253,
    images: ["/tastify-1.webp"],
  },
  {
    slug: "bonno",
    label: "Bonno",
    title: "Bonno Bartending",
    tagline: "You provide the liquor, we'll mix it — pro bono.",
    year: "2023",
    role: "Brand + site",
    kind: "art-bonno",
    color: "#93c8f2",
    x: 1160,
    y: -295,
    w: 411,
    h: 259,
    images: [],
  },
  {
    slug: "trellis",
    label: "Trellis",
    title: "Trellis",
    tagline: "Generate your design system foundation in minutes.",
    year: "2025",
    role: "Design technologist",
    kind: "browser",
    color: "#8ba6f2",
    x: -185,
    y: 531,
    w: 427,
    h: 307,
    images: ["/trellis-1.webp"],
  },
  {
    slug: "box",
    label: "Box",
    title: "Beat the Box",
    tagline: "A rhythm game played inside a single rectangle.",
    year: "2024",
    role: "Interaction engineering",
    kind: "art-box",
    color: "#e6d97a",
    x: 554,
    y: 380,
    w: 276,
    h: 212,
    images: [],
  },
  {
    slug: "trackit",
    label: "Trackit",
    title: "Trackit",
    tagline: "Padel sessions, tracked and analysed.",
    year: "2025",
    role: "Design + React Native",
    kind: "phones",
    color: "#86dcae",
    x: -1056,
    y: 741,
    w: 566,
    h: 363,
    images: ["/trackit-1.webp", "/trackit-2.webp", "/trackit-3.webp"],
  },
];

/** Empty space kept around the outermost islands, in world units. */
export const WORLD_PAD = 220;

export function islandBySlug(slug: string): Island | undefined {
  return ISLANDS.find((i) => i.slug === slug);
}

/**
 * How much the world contracts at a given viewport width. Positions and sizes
 * are both multiplied by this, so the arrangement is preserved exactly while
 * the distances shrink. The centre lockup is deliberately *not* scaled by this
 * — its type is clamped against the viewport instead, so it stays readable.
 */
export function worldScale(vw: number): number {
  if (vw >= 1200) return 1;
  if (vw >= 900) return 0.82;
  if (vw >= 640) return 0.64;
  return 0.5;
}
