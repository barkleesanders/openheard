-- Capture in the same SQLite statement as the product change. This covers
-- server functions, HTTP API and MCP writes without separate best-effort hooks.
-- No existing content is backfilled and the disposable public demo is excluded.
CREATE TABLE notification_event (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  workspace_id text NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('post', 'comment', 'status', 'changelog')),
  source_key text NOT NULL,
  entity_id integer NOT NULL,
  actor_id text REFERENCES user(id) ON DELETE SET NULL,
  payload text NOT NULL CHECK (json_valid(payload)),
  created_at integer NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
  planned_at integer,
  completed_at integer
);
CREATE UNIQUE INDEX notification_event_source_idx ON notification_event(kind, source_key);
CREATE INDEX notification_event_pending_idx ON notification_event(planned_at, id);
CREATE INDEX notification_event_workspace_idx ON notification_event(workspace_id, id);

CREATE TABLE notification_delivery (
  event_id integer NOT NULL REFERENCES notification_event(id) ON DELETE CASCADE,
  recipient_key text NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'sending', 'accepted', 'skipped', 'unconfirmed')),
  attempted_at integer,
  accepted_at integer,
  provider_message_id text,
  last_error text,
  PRIMARY KEY (event_id, recipient_key),
  CHECK (state != 'accepted' OR (accepted_at IS NOT NULL AND provider_message_id IS NOT NULL AND length(trim(provider_message_id)) > 0))
);
CREATE INDEX notification_delivery_pending_idx ON notification_delivery(state, event_id);

CREATE TRIGGER notification_post_created AFTER INSERT ON post
WHEN NEW.workspace_id != 'demo'
BEGIN
  INSERT INTO notification_event (workspace_id, kind, source_key, entity_id, actor_id, payload)
  VALUES (NEW.workspace_id, 'post', cast(NEW.id as text), NEW.id, NEW.author_id,
    json_object('postId', NEW.id, 'title', NEW.title, 'body', NEW.body));
END;

CREATE TRIGGER notification_comment_created AFTER INSERT ON comment
WHEN NEW.internal = 0
BEGIN
  INSERT INTO notification_event (workspace_id, kind, source_key, entity_id, actor_id, payload)
  SELECT p.workspace_id, 'comment', cast(NEW.id as text), NEW.id, NEW.author_id,
    json_object('postId', p.id, 'commentId', NEW.id, 'title', p.title, 'body', NEW.body)
  FROM post p WHERE p.id = NEW.post_id AND p.workspace_id != 'demo';
END;

-- Status writes precede activity writes in existing callers. Capturing here
-- prevents a crash between them from losing the event. The actor is unknown;
-- do not attribute the action to a previous activity or the post author.
CREATE TRIGGER notification_post_status AFTER UPDATE OF status ON post
WHEN OLD.status IS NOT NEW.status AND NEW.workspace_id != 'demo'
BEGIN
  INSERT INTO notification_event (workspace_id, kind, source_key, entity_id, payload)
  VALUES (NEW.workspace_id, 'status', lower(hex(randomblob(16))), NEW.id,
    json_object('postId', NEW.id, 'title', NEW.title, 'fromStatus', OLD.status, 'toStatus', NEW.status));
END;

CREATE TRIGGER notification_changelog_created AFTER INSERT ON changelog_entry
WHEN NEW.published_at IS NOT NULL AND NEW.workspace_id != 'demo'
BEGIN
  INSERT INTO notification_event (workspace_id, kind, source_key, entity_id, actor_id, payload)
  VALUES (NEW.workspace_id, 'changelog', cast(NEW.id as text), NEW.id, NEW.author_id,
    json_object('entryId', NEW.id, 'title', NEW.title, 'body', NEW.body, 'version', NEW.version))
  ON CONFLICT(kind, source_key) DO NOTHING;
END;

CREATE TRIGGER notification_changelog_published AFTER UPDATE OF published_at ON changelog_entry
WHEN OLD.published_at IS NULL AND NEW.published_at IS NOT NULL AND NEW.workspace_id != 'demo'
BEGIN
  INSERT INTO notification_event (workspace_id, kind, source_key, entity_id, actor_id, payload)
  VALUES (NEW.workspace_id, 'changelog', cast(NEW.id as text), NEW.id, NEW.author_id,
    json_object('entryId', NEW.id, 'title', NEW.title, 'body', NEW.body, 'version', NEW.version))
  ON CONFLICT(kind, source_key) DO NOTHING;
END;
