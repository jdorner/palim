ALTER TABLE `session_messages` ADD `client_id` text;--> statement-breakpoint
CREATE INDEX `idx_session_messages_session_client` ON `session_messages` (`session_id`,`client_id`);
