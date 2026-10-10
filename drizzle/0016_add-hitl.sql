CREATE TABLE `hitl_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`source_ref` text NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`context` text,
	`outcomes` text NOT NULL,
	`form_schema` text,
	`require_comment` integer DEFAULT false NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`due_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	`completed_by` text,
	`outcome` text,
	`response` text,
	`comment` text,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_hitl_tasks_status` ON `hitl_tasks` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_hitl_tasks_source` ON `hitl_tasks` (`source_kind`,`source_id`);--> statement-breakpoint
CREATE INDEX `idx_hitl_tasks_completed_by` ON `hitl_tasks` (`completed_by`);--> statement-breakpoint
CREATE TABLE `hitl_task_assignees` (
	`task_id` text NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`task_id`, `kind`, `value`)
);
--> statement-breakpoint
CREATE INDEX `idx_hitl_task_assignees_lookup` ON `hitl_task_assignees` (`kind`,`value`);--> statement-breakpoint
CREATE TABLE `hitl_task_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`at` integer NOT NULL,
	`actor_id` text,
	`kind` text NOT NULL,
	`data` text
);
--> statement-breakpoint
CREATE INDEX `idx_hitl_task_events_task` ON `hitl_task_events` (`task_id`,`id`);
