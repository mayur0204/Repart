/**
 * SAMPLE illustrations (public/sample) for demo data with no uploaded photo.
 * Generic drawings by category group, never a picture of a real product.
 */
const GROUPS: Record<string, string> = {
  Brakes: "brakes",
  "Brake pads": "brakes",
  "Brake discs": "brakes",
  "Brake levers": "controls",
  "Wheels and tyres": "wheels",
  Tyres: "wheels",
  Wheels: "wheels",
  "Suspension and steering": "suspension",
  Suspension: "suspension",
  "Steering parts": "suspension",
  "Engine and transmission": "engine",
  Exhausts: "engine",
  "Clutch parts": "engine",
  "Clutch levers": "controls",
  "Engine parts": "engine",
  "Electricals and lights": "electricals",
  "ECUs and electricals": "electricals",
  Lights: "electricals",
  "Body and seating": "body",
  Mirrors: "body",
  "Body panels and fairings": "body",
  Seats: "body",
  "Controls and accessories": "controls",
  Grips: "controls",
  Accessories: "controls",
};

export function sampleImageFor(categoryName: string | null | undefined): string | null {
  const group = categoryName ? GROUPS[categoryName] : undefined;
  return group ? `/sample/${group}.svg` : null;
}
