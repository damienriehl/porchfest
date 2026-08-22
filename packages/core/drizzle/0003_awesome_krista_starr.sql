CREATE TABLE `act_availabilities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season_id` integer NOT NULL,
	`act_id` integer NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`act_id`) REFERENCES `acts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "act_availabilities_window_check" CHECK("act_availabilities"."ends_at" > "act_availabilities"."starts_at")
);
--> statement-breakpoint
CREATE INDEX `act_availabilities_season_id_idx` ON `act_availabilities` (`season_id`);--> statement-breakpoint
CREATE INDEX `act_availabilities_act_id_idx` ON `act_availabilities` (`act_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `act_availabilities_act_id_window_uidx` ON `act_availabilities` (`act_id`,`starts_at`,`ends_at`);--> statement-breakpoint
CREATE TABLE `venue_amenities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season_id` integer NOT NULL,
	`venue_id` integer NOT NULL,
	`value` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`venue_id`) REFERENCES `venues`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "venue_amenities_value_check" CHECK("venue_amenities"."value" in ('seating', 'shade', 'restroom', 'accessible_entry', 'parking', 'other'))
);
--> statement-breakpoint
CREATE INDEX `venue_amenities_season_id_idx` ON `venue_amenities` (`season_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `venue_amenities_venue_id_value_uidx` ON `venue_amenities` (`venue_id`,`value`);--> statement-breakpoint
CREATE TABLE `venue_drinks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season_id` integer NOT NULL,
	`venue_id` integer NOT NULL,
	`value` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`venue_id`) REFERENCES `venues`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "venue_drinks_value_check" CHECK("venue_drinks"."value" in ('water', 'non_alcoholic', 'beer', 'wine', 'other'))
);
--> statement-breakpoint
CREATE INDEX `venue_drinks_season_id_idx` ON `venue_drinks` (`season_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `venue_drinks_venue_id_value_uidx` ON `venue_drinks` (`venue_id`,`value`);--> statement-breakpoint
CREATE TABLE `venue_gear` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season_id` integer NOT NULL,
	`venue_id` integer NOT NULL,
	`value` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`venue_id`) REFERENCES `venues`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "venue_gear_value_check" CHECK("venue_gear"."value" in ('pa', 'microphone', 'microphone_stand', 'instrument_amplifier', 'drum_kit', 'keyboard', 'music_stand', 'extension_cord', 'power_strip', 'other'))
);
--> statement-breakpoint
CREATE INDEX `venue_gear_season_id_idx` ON `venue_gear` (`season_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `venue_gear_venue_id_value_uidx` ON `venue_gear` (`venue_id`,`value`);--> statement-breakpoint
ALTER TABLE `acts` ADD `duration_minutes` integer;--> statement-breakpoint
ALTER TABLE `acts` ADD `requires_amplification` integer;--> statement-breakpoint
ALTER TABLE `acts` ADD `house_preference` text;--> statement-breakpoint
ALTER TABLE `acts` ADD `can_lend_gear` integer;--> statement-breakpoint
ALTER TABLE `venues` ADD `space_description` text;--> statement-breakpoint
ALTER TABLE `venues` ADD `has_power` integer;--> statement-breakpoint
ALTER TABLE `venues` ADD `rain_backup` integer;
