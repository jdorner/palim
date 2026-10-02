CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL DEFAULT '',
	`display_name` text,
	`provider` text NOT NULL DEFAULT 'local',
	`provider_subject` text,
	`disabled` integer NOT NULL DEFAULT false,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_users_username` ON `users` (`username`);--> statement-breakpoint
CREATE TABLE `roles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`built_in` integer NOT NULL DEFAULT false,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_roles_name` ON `roles` (`name`);--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`role_id` text NOT NULL,
	`permission` text NOT NULL,
	PRIMARY KEY(`role_id`, `permission`)
);
--> statement-breakpoint
CREATE TABLE `user_roles` (
	`user_id` text NOT NULL,
	`role_id` text NOT NULL,
	PRIMARY KEY(`user_id`, `role_id`)
);
--> statement-breakpoint
CREATE TABLE `user_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_used_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_user_sessions_token_hash` ON `user_sessions` (`token_hash`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `user_id` text;--> statement-breakpoint
ALTER TABLE `ext_filewatcher_watchers` ADD `created_by_user_id` text;--> statement-breakpoint
ALTER TABLE `ext_webhooks_registrations` ADD `created_by_user_id` text;
