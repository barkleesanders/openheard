import { createFileRoute } from "@tanstack/react-router";
import { SubscriptionAction } from "@/components/subscription-form";

export const Route = createFileRoute("/updates")({
  validateSearch: (search: Record<string, unknown>) => ({
    mode: typeof search.mode === "string" ? search.mode : "",
    id: typeof search.id === "string" ? search.id : "",
    token: typeof search.token === "string" ? search.token : "",
  }),
  head: () => ({
    meta: [
      { title: "Email updates" },
      { name: "robots", content: "noindex, nofollow" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: UpdatesPage,
});

function UpdatesPage() {
  const search = Route.useSearch();
  return (
    <main>
      <SubscriptionAction key={`${search.mode}:${search.id}:${search.token}`} {...search} />
    </main>
  );
}
