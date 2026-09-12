CREATE TABLE `_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`collection` text NOT NULL,
	`recordId` text NOT NULL,
	`action` text NOT NULL,
	`created` text DEFAULT (strftime('%Y-%m-%d %H:%M:%fZ')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx__changes_collection` ON `_changes` (`collection`,`id`);--> statement-breakpoint
CREATE TABLE `_realtime_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`subscriptions` text DEFAULT '[]' NOT NULL,
	`token` text DEFAULT '' NOT NULL,
	`created` text DEFAULT (strftime('%Y-%m-%d %H:%M:%fZ')) NOT NULL,
	`updated` text DEFAULT (strftime('%Y-%m-%d %H:%M:%fZ')) NOT NULL
);
