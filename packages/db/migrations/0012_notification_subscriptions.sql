-- No voters or existing addresses are enrolled by this migration.
CREATE TABLE notification_subscription (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  scope_key text NOT NULL,
  post_id integer REFERENCES post(id) ON DELETE CASCADE,
  email text NOT NULL,
  token_hash text,
  token_expires_at integer,
  confirmed_at integer,
  unsubscribed_at integer,
  last_requested_at integer NOT NULL,
  CHECK ((scope_key = 'changelog' AND post_id IS NULL) OR (post_id IS NOT NULL AND scope_key = 'post:' || post_id))
);
CREATE UNIQUE INDEX notification_subscription_recipient_idx ON notification_subscription(workspace_id, scope_key, email);
CREATE INDEX notification_subscription_confirmed_idx ON notification_subscription(workspace_id, confirmed_at, unsubscribed_at);
