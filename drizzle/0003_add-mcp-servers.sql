CREATE TABLE IF NOT EXISTS `ext_mcp_servers` (
	`name` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`config` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`tools_hash` text,
	`last_synced_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL
);
