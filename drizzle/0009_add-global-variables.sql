CREATE TABLE `global_variables` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`variable_key` text NOT NULL,
	`value` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_global_variables_key` ON `global_variables` (`variable_key`);
