import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";

/** Read-only vehicle tree for the bike selector. Admin editing arrives in M3. */
export type VehicleCatalogue = Array<{
  id: string;
  name: string;
  models: Array<{ id: string; name: string; variants: Array<{ id: string; name: string; yearFrom: number; yearTo: number | null }> }>;
}>;

export async function getVehicleCatalogue(db: Pick<PrismaClient, "vehicleMake">): Promise<VehicleCatalogue> {
  return db.vehicleMake.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      models: {
        where: { vehicleType: { in: ["MOTORCYCLE", "SCOOTER"] } },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          variants: { orderBy: [{ name: "asc" }, { yearFrom: "asc" }], select: { id: true, name: true, yearFrom: true, yearTo: true } },
        },
      },
    },
  });
}
