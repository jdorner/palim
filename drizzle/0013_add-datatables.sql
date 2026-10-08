CREATE TABLE IF NOT EXISTS `ext_datatables_tables` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`label` text NOT NULL,
	`description` text,
	`columns` text NOT NULL,
	`key_column` text,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_ext_datatables_tables_name` ON `ext_datatables_tables` (`name`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ext_datatables_rows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`table_id` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_ext_datatables_rows_table` ON `ext_datatables_rows` (`table_id`,`id`);
