import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "RePart",
    short_name: "RePart",
    description: "Used motorcycle and scooter parts, checked and delivered.",
    start_url: "/",
    display: "standalone",
    background_color: "#f2f4f5",
    theme_color: "#1a2126",
    lang: "en-IN",
    scope: "/",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // The glyph sits inside the central safe zone on a full-bleed background, so the same art works masked.
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
