CREATE TABLE `workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_name` text NOT NULL,
	`status` text NOT NULL DEFAULT 'running',
	`step_results` text NOT NULL DEFAULT '{}',
	`trigger_payload` text,
	`current_step_index` integer NOT NULL DEFAULT 0,
	`full_step_order` text NOT NULL,
	`failure_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_workflow_runs_name` ON `workflow_runs` (`workflow_name`);--> statement-breakpoint
CREATE INDEX `idx_workflow_runs_status` ON `workflow_runs` (`status`);
