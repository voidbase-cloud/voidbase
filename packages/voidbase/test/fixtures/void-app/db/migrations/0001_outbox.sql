CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`to` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `outbox_to_idx` ON `outbox` (`to`);
