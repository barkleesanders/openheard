import { changelogEntry, createDb } from "@openheard/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { purgeWorkspaceCache } from "@/lib/cache";
import { saveChangelogEntry } from "@/lib/changelog-write";
import { requireAdmin, sessionMiddleware } from "@/lib/session";

export const listChangelog = createServerFn({ method: "GET" })
  .middleware([sessionMiddleware])
  .handler(async ({ context }) => {
    const db = createDb();
    const admin = context.user?.role === "admin";
    const entries = await db.query.changelogEntry.findMany({
      where: and(
        eq(changelogEntry.workspaceId, context.workspace.id),
        admin ? undefined : isNotNull(changelogEntry.publishedAt),
      ),
      orderBy: [desc(sql`coalesce(${changelogEntry.publishedAt}, ${changelogEntry.createdAt})`)],
      with: { posts: { with: { post: { columns: { id: true, title: true, voteCount: true } } } } },
    });
    return entries.map((e) => ({ ...e, posts: e.posts.map((p) => p.post) }));
  });

export const saveChangelog = createServerFn({ method: "POST" })
  .middleware([sessionMiddleware])
  .validator((d: unknown) =>
    z
      .object({
        id: z.number().int().optional(),
        title: z.string().trim().min(3).max(140),
        body: z.string().trim().max(20000).default(""),
        version: z.string().trim().max(40).optional(),
        postIds: z.array(z.number().int()).max(50).default([]),
        publish: z.boolean().default(true),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const u = requireAdmin(context.user);
    const db = createDb();
    const result = await saveChangelogEntry(db, context.workspace.id, u.id, data);
    purgeWorkspaceCache(new URL(getRequest().url).origin);
    return result;
  });

export const deleteChangelog = createServerFn({ method: "POST" })
  .middleware([sessionMiddleware])
  .validator((d: unknown) => z.object({ id: z.number().int() }).parse(d))
  .handler(async ({ data, context }) => {
    requireAdmin(context.user);
    await createDb()
      .delete(changelogEntry)
      .where(and(eq(changelogEntry.id, data.id), eq(changelogEntry.workspaceId, context.workspace.id)));
    purgeWorkspaceCache(new URL(getRequest().url).origin);
    return { ok: true };
  });
