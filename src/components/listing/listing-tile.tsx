import Link from "next/link";
import { Badge, Price } from "@/components/ui/display";
import { Icon } from "@/components/ui/icon";
import { GRADE_TEXT, type Grade } from "@/lib/listing";
import { sampleImageFor } from "@/lib/sample-images";
import { FitLine, type Fit } from "./fit-bar";

export type TileData = {
  id: string;
  title: string;
  pricePaise: number;
  grade: string | null;
  fulfilmentMode: "DELIVERY" | "LOCAL_PICKUP";
  isSample: boolean;
  location: string | null;
  distanceKm: number | null;
  photoUrl: string | null;
  categoryName?: string | null;
  fit: Fit;
  match: string | null;
};

/**
 * Listing tile (Stitch part card): white card, 1px border, 16px corners, square photo with the grade pill on it;
 * then fit line, title, price, location and delivery. List row on mobile, grid card from lg up (brief §9).
 * Hover darkens the border only (no lift).
 */
export function ListingTile({ tile }: { tile: TileData }) {
  const grade = tile.grade ? GRADE_TEXT[tile.grade as Grade]?.label : null;
  const sampleImage = tile.isSample && !tile.photoUrl ? sampleImageFor(tile.categoryName) : null;
  const where = [tile.location, tile.distanceKm !== null ? `${tile.distanceKm} km away` : null].filter(Boolean).join(", ");
  return (
    <Link
      href={`/listings/${tile.id}`}
      className="grid h-full grid-cols-[6rem_1fr] gap-3 overflow-hidden rounded-lg border border-rule bg-surface p-2 transition-colors duration-150 hover:border-ink sm:grid-cols-[8rem_1fr] lg:flex lg:flex-col lg:gap-0 lg:p-0"
    >
      <div className="relative">
        {tile.photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL from private storage
          <img loading="lazy" decoding="async" src={tile.photoUrl} alt={tile.title} className="aspect-square w-full rounded-md bg-page object-cover lg:rounded-none" />
        ) : sampleImage ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element -- static SVG illustration */}
            <img loading="lazy" decoding="async" src={sampleImage} alt={`SAMPLE illustration: ${tile.categoryName}`} className="aspect-square w-full rounded-md bg-page object-cover lg:rounded-none" />
            <span className="absolute bottom-2 left-2 hidden rounded-full bg-surface px-2.5 py-0.5 text-sm font-semibold text-ink lg:inline-block">SAMPLE image</span>
          </>
        ) : (
          <div className="flex aspect-square w-full items-center justify-center rounded-md bg-page text-sm text-steel lg:rounded-none">No photo yet</div>
        )}
        {grade ? (
          <span className="absolute top-2 left-2 hidden rounded-full bg-surface px-2.5 py-0.5 text-sm font-semibold text-ink lg:inline-block">{grade}</span>
        ) : null}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 lg:p-4">
        <FitLine fit={tile.fit} />
        <span className="font-heading font-semibold text-ink">{tile.title}</span>
        {tile.match ? <span className="text-sm text-steel">{tile.match}</span> : null}
        {grade ? <span className="text-sm text-steel lg:hidden">{grade}</span> : null}
        <div className="mt-auto flex flex-col gap-1 pt-1">
          <Price paise={tile.pricePaise} size="md" />
          <span className="flex items-start gap-1 text-sm text-steel">
            <Icon name={tile.fulfilmentMode === "DELIVERY" ? "truck" : "location"} size="sm" className="mt-0.5 shrink-0" />
            <span>
              {where}
              {where ? ". " : ""}
              {tile.fulfilmentMode === "DELIVERY" ? "Delivery available" : "Local pickup only"}
            </span>
          </span>
          {tile.isSample ? <span><Badge tone="caution" icon={false}>SAMPLE</Badge></span> : null}
        </div>
      </div>
    </Link>
  );
}
