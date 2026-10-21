import { createFileRoute } from "@tanstack/react-router";
import { handleSubscriptionRequest } from "@/lib/subscription-api";

export const Route = createFileRoute("/api/updates")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => handleSubscriptionRequest(request),
      POST: async ({ request }: { request: Request }) => handleSubscriptionRequest(request),
    },
  },
});
