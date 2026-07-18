CREATE TABLE `secrets_vault` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text NOT NULL,
	`secret_key` text NOT NULL,
	`encrypted_value` text NOT NULL,
	`iv` text NOT NULL,
	`key_version` integer DEFAULT 1 NOT NULL,
	`acl_consumers` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_vault_scope` ON `secrets_vault` (`scope`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_vault_scope_key` ON `secrets_vault` (`scope`,`secret_key`);