import Link from "next/link";
import { Badge, Price } from "@/components/ui/display";
import { GRADE_TEXT, type Grade } from "@/lib/listing";
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
  fit: Fit;
  match: string | null;
};

/**
 * Listing tile (brief §10): 1px border, square photo, no shadow; fit line, title, grade, price, then location and delivery.
 * List row on mobile, grid card from lg up (brief §9: "Grid on desktop, list on mobile").
 */
export function ListingTile({ tile }: { tile: TileData }) {
  const photo = tile.photoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL from private storage
    <img src={tile.photoUrl} alt={tile.title} className="aspect-square w-full object-cover" />
  ) : (
    <div className="flex aspect-square w-full items-center justify-center bg-page text-sm text-steel">No photo yet</div>
  );
  return (
    <Link
      href={`/listings/${tile.id}`}
      className="grid grid-cols-[6rem_1fr] gap-3 border border-rule bg-surface p-2 hover:border-ink sm:grid-cols-[8rem_1fr] lg:flex lg:flex-col lg:gap-0 lg:p-0"
    >
      {photo}
      <div className="flex flex-col gap-1 lg:p-3">
        <FitLine fit={tile.fit} />
        <span className="font-semibold text-ink">{tile.title}</span>
        {tile.match ? <span className="text-sm text-steel">{tile.match}</span> : null}
        {tile.grade ? <span className="text-sm text-steel">{GRADE_TEXT[tile.grade as Grade]?.label}</span> : null}
        <Price paise={tile.pricePaise} size="md" />
        <span className="text-sm text-steel">
          {[tile.location, tile.distanceKm !== null ? `${tile.distanceKm} km away` : null].filter(Boolean).join(", ")}
          {tile.location || tile.distanceKm !== null ? ". " : ""}
          {tile.fulfilmentMode === "DELIVERY" ? "Delivery available" : "Local pickup only"}
        </span>
        {tile.isSample ? <Badge tone="caution" icon={false}>SAMPLE</Badge> : null}
      </div>
    </Link>
  );
}
