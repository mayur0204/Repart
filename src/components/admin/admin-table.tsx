import type { ReactNode } from "react";

/** Plain bordered table for admin lists. Scrolls horizontally inside its own box on small screens. */
export function AdminTable({ head, children, empty }: { head: string[]; children: ReactNode; empty?: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-rule bg-surface">
      <table className="w-full min-w-[40rem] border-collapse text-left">
        <thead className="bg-page">
          <tr>
            {head.map((h) => (
              <th key={h} scope="col" className="border-b border-rule px-3 py-2 text-sm font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
      {empty}
    </div>
  );
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={`border-b border-rule px-3 py-2 align-top ${className ?? ""}`}>{children}</td>;
}
