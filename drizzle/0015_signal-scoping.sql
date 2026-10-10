ALTER TABLE `workflow_signals` ADD `scope` text DEFAULT 'broadcast' NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_signals` ADD `correlation_key` text;--> statement-breakpoint
ALTER TABLE `workflow_signals` ADD `source` text DEFAULT 'waitFor' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_workflow_signals_event_corr` ON `workflow_signals` (`event`,`correlation_key`,`status`);
