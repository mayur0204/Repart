import Link from "next/link";

/**
 * Stitch wordmark: "Re" in navy, "Part" in brand orange, tagline underneath from sm up.
 * Drawn as an SVG graphic (as the Stitch logo ships): logotypes are exempt from contrast rules, and the link carries the name.
 */
export function Logo() {
  return (
    <Link href="/" aria-label="RePart home" className="flex shrink-0 flex-col leading-none">
      <svg aria-hidden="true" viewBox="0 0 96 26" preserveAspectRatio="xMinYMid meet" className="h-7 w-24 self-start overflow-visible">
        <text x="0" y="21" fontSize="26" fontWeight="800" style={{ fontFamily: "var(--font-heading)" }}>
          <tspan fill="#0f172a">Re</tspan>
          <tspan fill="#ff6b35">Part</tspan>
        </text>
      </svg>
      <span aria-hidden="true" className="hidden pt-1 text-[0.625rem] font-semibold text-steel sm:block">Pre-loved parts. More roads.</span>
    </Link>
  );
}
