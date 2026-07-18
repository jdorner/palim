CREATE TABLE IF NOT EXISTS `secret_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`secret_name` text NOT NULL,
	`consumer` text NOT NULL,
	`action` text NOT NULL,
	`result` text NOT NULL,
	`timestamp` integer NOT NULL,
	`reason` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_secret_audit_timestamp` ON `secret_audit_log` (`timestamp`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_secret_audit_secret` ON `secret_audit_log` (`secret_name`);
