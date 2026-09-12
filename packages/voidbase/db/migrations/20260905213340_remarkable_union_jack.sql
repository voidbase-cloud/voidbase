CREATE TABLE `_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`created` text DEFAULT '' NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`level` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_logs_created` ON `_logs` (`created`);--> statement-breakpoint
CREATE INDEX `idx_logs_level` ON `_logs` (`level`);--> statement-breakpoint
CREATE INDEX `idx_logs_message` ON `_logs` (`message`);