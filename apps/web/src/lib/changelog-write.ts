import type { Db } from "@openheard/db";
import { activity, changelogEntry, changelogPost, post } from "@openheard/db";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { statusOfKind } from "./status-db";

// D1 allows 100 bound parameters per query:
// https://developers.cloudflare.com/d1/platform/limits/
// Forty IDs leave room for status, tenant and publication guards. Every ID is
// processed; this is a parameter batch, not a read cap.
export async function linkedPublicationWrites(
  db: Db,
  workspaceId: string,
  postIds: number[],
  actorId: string | null,
  note: string,
  draftEntryId?: number,
) {
  const writes: BatchItem<"sqlite">[] = [];
  const done = (await statusOfKind(db, workspaceId, "done"))?.key ?? "done";
  for (let index = 0; index < postIds.length; index += 40) {
    const ids = postIds.slice(index, index + 40);
    const linked = await db
      .select({ id: post.id, status: post.status })
      .from(post)
      .where(and(eq(post.workspaceId, workspaceId), inArray(post.id, ids)));
    if (linked.length !== ids.length) throw new Error("Post not found");
    const predicate = and(
      eq(post.workspaceId, workspaceId),
      inArray(post.id, ids),
      ne(post.status, done),
      draftEntryId === undefined
        ? undefined
        : sql`EXISTS (SELECT 1 FROM ${changelogEntry} WHERE ${changelogEntry.id} = ${draftEntryId} AND ${changelogEntry.workspaceId} = ${workspaceId} AND ${changelogEntry.publishedAt} IS NULL)`,
    );
    // Read the actual from-status inside the transaction, not from a stale
    // preflight. The explicit SELECT columns match the activity schema order.
    writes.push(
      db
        .insert(activity)
        .select(
          sql`SELECT NULL, ${post.id}, ${actorId}, 'status', ${post.status}, ${done}, ${note}, (cast(unixepoch('subsecond') * 1000 as integer)) FROM ${post} WHERE ${predicate}`,
        ),
      db.update(post).set({ status: done, statusChangedAt: new Date() }).where(predicate),
    );
  }
  return writes;
}

export async function saveChangelogEntry(
  db: Db,
  workspaceId: string,
  actorId: string,
  data: {
    id?: number;
    title: string;
    body: string;
    version?: string;
    postIds: number[];
    publish: boolean;
  },
) {
  let id = data.id;
  let publishedAt: Date | null = null;
  if (id !== undefined) {
    const [owned] = await db
      .select({ id: changelogEntry.id, publishedAt: changelogEntry.publishedAt })
      .from(changelogEntry)
      .where(and(eq(changelogEntry.id, id), eq(changelogEntry.workspaceId, workspaceId)))
      .limit(1);
    if (!owned) throw new Error("Changelog entry not found");
    publishedAt = owned.publishedAt;
  }
  const postIds = [...new Set(data.postIds)];
  // Validate and prepare all linked writes before creating even a draft row.
  const shipping = data.publish
    ? await linkedPublicationWrites(db, workspaceId, postIds, actorId, `shipped in ${data.version || data.title}`)
    : [];
  if (!data.publish && postIds.length) {
    const owned = await db
      .select({ id: post.id })
      .from(post)
      .where(and(eq(post.workspaceId, workspaceId), inArray(post.id, postIds)));
    if (owned.length !== postIds.length) throw new Error("Post not found");
  }
  const values = { workspaceId, title: data.title, body: data.body, version: data.version || null, authorId: actorId };
  if (id === undefined) {
    const [created] = await db
      .insert(changelogEntry)
      .values({ ...values, publishedAt: null })
      .returning({ id: changelogEntry.id });
    id = created.id;
  }
  const entryId = id;
  const first = db.delete(changelogPost).where(eq(changelogPost.entryId, entryId));
  const remaining: BatchItem<"sqlite">[] = [];
  if (postIds.length) remaining.push(db.insert(changelogPost).values(postIds.map((postId) => ({ entryId, postId }))));
  remaining.push(...shipping);
  // D1 batch is transactional. Publication is the final statement, so neither
  // public readers nor a queue consumer can observe missing links/status writes.
  // Edits preserve the original publication date and do not create another send.
  remaining.push(
    db
      .update(changelogEntry)
      .set({ ...values, publishedAt: data.publish ? (publishedAt ?? new Date()) : null })
      .where(and(eq(changelogEntry.id, entryId), eq(changelogEntry.workspaceId, workspaceId))),
  );
  await db.batch([first, ...remaining]);
  return { id: entryId };
}
