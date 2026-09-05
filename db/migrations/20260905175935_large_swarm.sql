CREATE TABLE `_authOrigins` (
	`id` text PRIMARY KEY DEFAULT ('r'||lower(hex(randomblob(7)))) NOT NULL,
	`collectionRef` text DEFAULT '' NOT NULL,
	`recordRef` text DEFAULT '' NOT NULL,
	`created` text DEFAULT '' NOT NULL,
	`updated` text DEFAULT '' NOT NULL,
	`fingerprint` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_authOrigins_unique_pairs` ON `_authOrigins` (`collectionRef`,`recordRef`,`fingerprint`);--> statement-breakpoint
CREATE TABLE `_collections` (
	`id` text PRIMARY KEY DEFAULT ('r'||lower(hex(randomblob(7)))) NOT NULL,
	`system` integer DEFAULT false NOT NULL,
	`type` text DEFAULT 'base' NOT NULL,
	`name` text NOT NULL,
	`fields` text DEFAULT '[]' NOT NULL,
	`indexes` text DEFAULT '[]' NOT NULL,
	`listRule` text,
	`viewRule` text,
	`createRule` text,
	`updateRule` text,
	`deleteRule` text,
	`options` text DEFAULT '{}' NOT NULL,
	`created` text DEFAULT (strftime('%Y-%m-%d %H:%M:%fZ')) NOT NULL,
	`updated` text DEFAULT (strftime('%Y-%m-%d %H:%M:%fZ')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `_collections_name_unique` ON `_collections` (`name`);--> statement-breakpoint
CREATE INDEX `idx__collections_type` ON `_collections` (`type`);--> statement-breakpoint
CREATE TABLE `_externalAuths` (
	`id` text PRIMARY KEY DEFAULT ('r'||lower(hex(randomblob(7)))) NOT NULL,
	`collectionRef` text DEFAULT '' NOT NULL,
	`recordRef` text DEFAULT '' NOT NULL,
	`created` text DEFAULT '' NOT NULL,
	`updated` text DEFAULT '' NOT NULL,
	`provider` text DEFAULT '' NOT NULL,
	`providerId` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_externalAuths_record_provider` ON `_externalAuths` (`collectionRef`,`recordRef`,`provider`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_externalAuths_collection_provider` ON `_externalAuths` (`collectionRef`,`provider`,`providerId`);--> statement-breakpoint
CREATE TABLE `_mfas` (
	`id` text PRIMARY KEY DEFAULT ('r'||lower(hex(randomblob(7)))) NOT NULL,
	`collectionRef` text DEFAULT '' NOT NULL,
	`recordRef` text DEFAULT '' NOT NULL,
	`created` text DEFAULT '' NOT NULL,
	`updated` text DEFAULT '' NOT NULL,
	`method` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_mfas_collectionRef_recordRef` ON `_mfas` (`collectionRef`,`recordRef`);--> statement-breakpoint
CREATE TABLE `_pbMigrations` (
	`file` text PRIMARY KEY NOT NULL,
	`applied` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `_otps` (
	`id` text PRIMARY KEY DEFAULT ('r'||lower(hex(randomblob(7)))) NOT NULL,
	`collectionRef` text DEFAULT '' NOT NULL,
	`recordRef` text DEFAULT '' NOT NULL,
	`created` text DEFAULT '' NOT NULL,
	`updated` text DEFAULT '' NOT NULL,
	`password` text DEFAULT '' NOT NULL,
	`sentTo` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_otps_collectionRef_recordRef` ON `_otps` (`collectionRef`,`recordRef`);--> statement-breakpoint
CREATE TABLE `_params` (
	`id` text PRIMARY KEY DEFAULT ('r'||lower(hex(randomblob(7)))) NOT NULL,
	`value` text,
	`created` text DEFAULT (strftime('%Y-%m-%d %H:%M:%fZ')) NOT NULL,
	`updated` text DEFAULT (strftime('%Y-%m-%d %H:%M:%fZ')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `_superusers` (
	`id` text PRIMARY KEY DEFAULT ('r'||lower(hex(randomblob(7)))) NOT NULL,
	`password` text DEFAULT '' NOT NULL,
	`tokenKey` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`emailVisibility` integer DEFAULT false NOT NULL,
	`verified` integer DEFAULT false NOT NULL,
	`created` text DEFAULT '' NOT NULL,
	`updated` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tokenKey_pbc_3142635823` ON `_superusers` (`tokenKey`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_email_pbc_3142635823` ON `_superusers` (`email`) WHERE "_superusers"."email" != '';