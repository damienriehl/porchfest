CREATE TABLE `organizer_invites` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`token_hash` text NOT NULL,
	`email` text,
	`invited_by_organizer_id` integer,
	`expires_at` integer NOT NULL,
	`redeemed_at` integer,
	`redeemed_by_organizer_id` integer,
	`redeemed_from_ip` text,
	`revoked_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`invited_by_organizer_id`) REFERENCES `organizers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`redeemed_by_organizer_id`) REFERENCES `organizers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "organizer_invites_kind_check" CHECK("organizer_invites"."kind" in ('bootstrap', 'invite'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizer_invites_token_hash_uidx` ON `organizer_invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `organizer_invites_kind_idx` ON `organizer_invites` (`kind`);--> statement-breakpoint
CREATE TABLE `organizer_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizer_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`idle_expires_at` integer NOT NULL,
	`revoked_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`organizer_id`) REFERENCES `organizers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizer_sessions_token_hash_uidx` ON `organizer_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `organizer_sessions_organizer_id_idx` ON `organizer_sessions` (`organizer_id`);--> statement-breakpoint
CREATE TABLE `organizers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`deactivated_at` integer,
	`last_seen_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizers_email_uidx` ON `organizers` (`email`);