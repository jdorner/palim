CREATE TABLE IF NOT EXISTS `ext_extension_hub_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`branch` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_fetched_at` integer,
	`last_error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_ext_extension_hub_sources_name` ON `ext_extension_hub_sources` (`name`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ext_extension_hub_installs` (
	`name` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`ref` text NOT NULL,
	`ref_kind` text NOT NULL,
	`version` text NOT NULL,
	`commit` text NOT NULL,
	`content_hash` text NOT NULL,
	`installed_at` integer NOT NULL,
	`installed_by` text
);
