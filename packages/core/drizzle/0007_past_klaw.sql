CREATE TABLE `season_time_slots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season_id` integer NOT NULL,
	`position` integer NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "season_time_slots_window_check" CHECK("season_time_slots"."ends_at" > "season_time_slots"."starts_at")
);
--> statement-breakpoint
CREATE INDEX `season_time_slots_season_id_idx` ON `season_time_slots` (`season_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `season_time_slots_season_position_uidx` ON `season_time_slots` (`season_id`,`position`);--> statement-breakpoint
ALTER TABLE `seasons` ADD `event_date` text;--> statement-breakpoint
ALTER TABLE `seasons` ADD `signup_opens_at` integer;--> statement-breakpoint
ALTER TABLE `seasons` ADD `signup_closes_at` integer;--> statement-breakpoint
ALTER TABLE `seasons` ADD `locality_name` text;--> statement-breakpoint
ALTER TABLE `seasons` ADD `bounds_north` real;--> statement-breakpoint
ALTER TABLE `seasons` ADD `bounds_south` real;--> statement-breakpoint
ALTER TABLE `seasons` ADD `bounds_east` real;--> statement-breakpoint
ALTER TABLE `seasons` ADD `bounds_west` real;--> statement-breakpoint
ALTER TABLE `seasons` ADD `public_site_url` text;--> statement-breakpoint
ALTER TABLE `seasons` ADD `public_map_url` text;--> statement-breakpoint
ALTER TABLE `seasons` ADD `sender_name` text;--> statement-breakpoint
ALTER TABLE `seasons` ADD `sender_email` text;--> statement-breakpoint
ALTER TABLE `seasons` ADD `retention_days` integer;