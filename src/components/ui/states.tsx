import type { ReactNode } from "react";
import { Icon, type IconName } from "./icon";

/**
 * Screen states every page must handle (REPART_BRIEF.md §9): empty, error, offline, permission denied.
 * Copy says what happened and what to do next; no vague apologies.
 */
type StateProps = { title: string; body: ReactNode; action?: ReactNode };

function StatePanel({ icon, title, body, action, role }: StateProps & { icon: IconName; role?: "alert" }) {
  return (
    <section role={role} className="flex flex-col items-start gap-3 rounded-lg border border-rule bg-surface p-6">
      <span className="flex size-12 items-center justify-center rounded-full bg-brand-tint text-action">
        <Icon name={icon} size="lg" />
      </span>
      <h2 className="text-xl">{title}</h2>
      <div className="prose-measure text-steel">{body}</div>
      {action ? <div className="mt-1">{action}</div> : null}
    </section>
  );
}

export const EmptyState = (p: StateProps) => <StatePanel icon="empty" {...p} />;
export const ErrorState = (p: StateProps) => <StatePanel icon="error" role="alert" {...p} />;
export const OfflineState = (p: StateProps) => <StatePanel icon="offline" {...p} />;

export function PermissionDenied({ action, body }: { action?: ReactNode; body?: ReactNode }) {
  return (
    <StatePanel
      icon="lock"
      title="You don't have access to this page"
      body={body ?? "This page is for a different account type. Sign in with the right account, or go back to the home page."}
      action={action}
    />
  );
}
