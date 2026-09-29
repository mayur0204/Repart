import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PermissionDenied } from "@/components/ui/states";
import { adminPage } from "@/server/auth/current";

export const metadata: Metadata = { title: "Admin | RePart" };

// The overview dashboard arrives in M12; until then the catalogue is the admin home.
export default async function AdminHome() {
  if (!(await adminPage("/admin"))) return <PermissionDenied />;
  redirect("/admin/catalogue");
}
