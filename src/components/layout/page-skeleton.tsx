import { Skeleton } from "@/components/ui/display";

/**
 * Shown while a page's data loads: the Page layout's title, intro and content blocks as skeletons (no spinners).
 * Used by the `loading.tsx` files. They sit only above list and static pages, never above a page for one record
 * (`[id]` segments): once a skeleton has been sent the response is committed to 200, and a missing record must be a
 * real 404 (Next.js docs, loading.js "Status codes").
 */
export function PageSkeleton() {
  return (
    <main aria-busy="true" className="mx-auto flex max-w-(--container-page) flex-col gap-6 px-4 py-8 lg:px-8">
      <span className="sr-only" role="status">Loading</span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-9 w-2/3 max-w-md" />
        <Skeleton className="h-5 w-full max-w-xl" />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
      <Skeleton className="h-24 w-full" />
    </main>
  );
}
