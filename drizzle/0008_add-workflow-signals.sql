CREATE TABLE `workflow_signals` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`step_slug` text NOT NULL,
	`event` text NOT NULL,
	`status` text NOT NULL DEFAULT 'waiting',
	`input_schema` text,
	`timeout_ms` integer,
	`payload` text,
	`created_at` integer NOT NULL,
	`received_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_workflow_signals_run_event` ON `workflow_signals` (`run_id`,`event`);--> statement-breakpoint
CREATE INDEX `idx_workflow_signals_status` ON `workflow_signals` (`status`);
