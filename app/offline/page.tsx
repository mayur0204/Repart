import type { Metadata } from "next";
import { OfflineState } from "@/components/ui/states";

export const metadata: Metadata = { title: "You're offline | RePart" };

export default function OfflinePage() {
  return (
    <main className="mx-auto max-w-(--container-page) px-4 py-8 lg:px-8">
      <OfflineState
        title="You're offline"
        body="RePart needs a connection to load this page. Check your mobile data or Wi-Fi, then reload. Nothing you've saved is lost."
      />
    </main>
  );
}
