-- Squashed baseline: equivalent of migrations 0000 through 0012.
-- Generated from full schema (main + extension re-exports).

CREATE TABLE `app_config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `extension_settings` (
	`name` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`config` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `job_logs` (
	`job_id` text NOT NULL,
	`seq` integer NOT NULL,
	`message` text NOT NULL,
	`ts` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`job_id`, `seq`)
);
--> statement-breakpoint
CREATE TABLE `session_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`type` text DEFAULT 'text' NOT NULL,
	`timestamp` integer NOT NULL,
	`seq` integer NOT NULL,
	`tool_call_id` text,
	`tool_name` text,
	`usage` text
);
--> statement-breakpoint
CREATE INDEX `idx_session_messages_session_seq` ON `session_messages` (`session_id`,`seq`);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`source_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`metadata` text,
	`total_input_tokens` integer DEFAULT 0 NOT NULL,
	`total_output_tokens` integer DEFAULT 0 NOT NULL,
	`total_cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`total_cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`last_input_tokens` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_sessions_source` ON `sessions` (`source`,`source_id`);
--> statement-breakpoint
CREATE TABLE `ext_filewatcher_watchers` (
	`slug` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`patterns` text NOT NULL,
	`recursive` integer DEFAULT false NOT NULL,
	`process_existing` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ext_webhooks_registrations` (
	`slug` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`auth_type` text DEFAULT 'none' NOT NULL,
	`secret` text DEFAULT '' NOT NULL,
	`header_name` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ext_introspection_tool_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tool_name` text NOT NULL,
	`success` integer NOT NULL,
	`is_error` integer NOT NULL,
	`exit_code` integer,
	`skill_name` text,
	`source` text,
	`job_id` text,
	`tool_call_id` text,
	`timestamp` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ext_installer_registry` (
	`name` text PRIMARY KEY NOT NULL,
	`version` text NOT NULL,
	`source` text NOT NULL,
	`installed_at` integer NOT NULL,
	`bun_packages` text,
	`status` text NOT NULL DEFAULT 'installed',
	`metadata` text,
	`approval_token` text
);
--> statement-breakpoint
CREATE TABLE `secret_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`secret_name` text NOT NULL,
	`consumer` text NOT NULL,
	`action` text NOT NULL,
	`result` text NOT NULL,
	`timestamp` integer NOT NULL,
	`reason` text
);
--> statement-breakpoint
CREATE INDEX `idx_secret_audit_timestamp` ON `secret_audit_log` (`timestamp`);
--> statement-breakpoint
CREATE INDEX `idx_secret_audit_secret` ON `secret_audit_log` (`secret_name`);
