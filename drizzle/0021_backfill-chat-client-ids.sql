-- Chat user messages stored before client IDs get a random one, so the UI and
-- the server can identify every message by ID. Opening such a conversation then
-- resyncs it from the server once (its last user ID no longer matches).
UPDATE `session_messages` SET `client_id` = lower(hex(randomblob(16)))
WHERE `role` = 'user' AND `client_id` IS NULL
  AND `session_id` IN (SELECT `id` FROM `sessions` WHERE `source` = 'chat');
