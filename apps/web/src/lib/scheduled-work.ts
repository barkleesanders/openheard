import { emailSender, type Mailer } from "@openheard/auth/email-delivery";
import { createDb } from "@openheard/db";
import { env } from "@openheard/env/server";
import { resetDemoWorkspace } from "./demo-db";
import { dispatchNotifications } from "./notification-dispatch";

export async function runScheduledWork(cron: string) {
  if (cron === "0 4 * * *") {
    const { posts } = await resetDemoWorkspace(createDb());
    return { event: "demo.reset", posts };
  }
  if (cron !== "* * * * *") return { event: "scheduled.ignored" };
  const settings = env as unknown as {
    EMAIL?: Mailer;
    AUTH_EMAIL_FROM?: string;
    AUTH_EMAIL_FROM_NAME?: string;
    BETTER_AUTH_SECRET?: string;
    BETTER_AUTH_URL?: string;
    ROOT_DOMAIN?: string;
  };
  const from = emailSender(settings);
  return {
    event: "notifications.dispatch",
    ...(await dispatchNotifications(createDb(), {
      mailer: settings.EMAIL,
      secret: settings.BETTER_AUTH_SECRET ?? "",
      origin: settings.BETTER_AUTH_URL ?? "",
      rootDomain: settings.ROOT_DOMAIN,
      from,
      brand: from.name,
    })),
  };
}
