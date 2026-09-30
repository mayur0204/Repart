import type { Metadata } from "next";
import Link from "next/link";
import { AdminTable, Td } from "@/components/admin/admin-table";
import { Page } from "@/components/layout/page";
import { EmptyState, PermissionDenied } from "@/components/ui/states";
import { adminPage } from "@/server/auth/current";
import { admin } from "@/server/services";

export const metadata: Metadata = { title: "Agreement | Admin | RePart" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/**
 * Agreement dashboard (brief §9, PLAN.md milestone 12): automated risk decision vs mechanic outcome, per category.
 * Automated pass = routed LIVE with no hard failure, no failed rule and no admin-review flag. PASS_WITH_NOTES counts
 * as a mechanic pass. False-pass rate = automated pass but mechanic FAIL ÷ all inspected listings.
 */
export default async function AgreementPage({ searchParams }: Props) {
  if (!(await adminPage("/admin/agreement"))) return <PermissionDenied />;
  const includeSample = (await searchParams).includeSample === "true";
  const { byCategory, total } = await admin.agreement(includeSample);
  const head = ["Category", "Inspected", "Automated pass", "Automated non-pass", "Not assessed", "Mechanic pass", "Mechanic fail", "False pass", "False-pass rate"];
  const row = (r: typeof total, strong = false) => (
    <tr key={r.category} className={strong ? "font-semibold" : undefined}>
      <Td>{r.category}</Td>
      <Td className="num">{r.inspected}</Td>
      <Td className="num">{r.automatedPass}</Td>
      <Td className="num">{r.automatedNonPass}</Td>
      <Td className="num">{r.unassessed}</Td>
      <Td className="num">{r.mechanicPass}</Td>
      <Td className="num">{r.mechanicFail}</Td>
      <Td className="num">{r.falsePass}</Td>
      <Td className="num">{pct(r.falsePassRate)}</Td>
    </tr>
  );
  return (
    <Page
      title="Agreement"
      intro="How often the automated check and partner mechanics agree, per category. Each inspected listing counts once, using its latest inspection (required, optional and audit checks) and its latest risk assessment."
      actions={<Link href={includeSample ? "/admin/agreement" : "/admin/agreement?includeSample=true"} className="text-action underline underline-offset-4">{includeSample ? "Exclude sample data" : "Include sample data"}</Link>}
    >
      {total.inspected === 0 ? (
        <EmptyState title="No inspections yet" body="Figures appear once partner mechanics submit inspections." />
      ) : (
        <AdminTable head={head}>
          {byCategory.map((r) => row(r))}
          {row(total, true)}
        </AdminTable>
      )}
      <p className="text-sm text-steel">False-pass rate: listings the automated check passed that the mechanic failed, divided by all inspected listings in the row. Sample size is the Inspected column.</p>
    </Page>
  );
}
