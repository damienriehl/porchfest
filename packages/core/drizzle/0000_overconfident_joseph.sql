CREATE TABLE `acts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season_id` integer NOT NULL,
	`name` text NOT NULL,
	`genre` text,
	`description` text,
	`links` text,
	`placeholder` integer DEFAULT false NOT NULL,
	`reach_via_contact_id` integer,
	`canonical_act_id` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reach_via_contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`canonical_act_id`) REFERENCES `acts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `acts_season_id_idx` ON `acts` (`season_id`);--> statement-breakpoint
CREATE TABLE `annotations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season_id` integer NOT NULL,
	`record_type` text NOT NULL,
	`record_id` integer NOT NULL,
	`note` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `annotations_season_id_idx` ON `annotations` (`season_id`);--> statement-breakpoint
CREATE TABLE `assignments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season_id` integer NOT NULL,
	`act_id` integer NOT NULL,
	`slot_id` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`act_id`) REFERENCES `acts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`slot_id`) REFERENCES `slots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `assignments_season_id_idx` ON `assignments` (`season_id`);--> statement-breakpoint
CREATE INDEX `assignments_act_id_idx` ON `assignments` (`act_id`);--> statement-breakpoint
CREATE INDEX `assignments_slot_id_idx` ON `assignments` (`slot_id`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season_id` integer NOT NULL,
	`name` text NOT NULL,
	`email` text,
	`phone` text,
	`canonical_contact_id` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`canonical_contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `contacts_season_id_idx` ON `contacts` (`season_id`);--> statement-breakpoint
CREATE TABLE `seasons` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`year` integer NOT NULL,
	`display_name` text NOT NULL,
	`state` text DEFAULT 'setup' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT "seasons_state_check" CHECK("seasons"."state" in ('setup', 'signups_open', 'signups_closed', 'assigning', 'locked', 'archived'))
);
--> statement-breakpoint
CREATE TABLE `slots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season_id` integer NOT NULL,
	`venue_id` integer NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`held_decide_by` integer,
	`held_for_name` text,
	`fallback_venue_id` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`venue_id`) REFERENCES `venues`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fallback_venue_id`) REFERENCES `venues`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "slots_state_check" CHECK("slots"."state" in ('open', 'held', 'assigned')),
	CONSTRAINT "slots_held_details_check" CHECK("slots"."state" <> 'held' or ("slots"."held_decide_by" is not null and "slots"."held_for_name" is not null)),
	CONSTRAINT "slots_window_check" CHECK("slots"."ends_at" > "slots"."starts_at")
);
--> statement-breakpoint
CREATE INDEX `slots_season_id_idx` ON `slots` (`season_id`);--> statement-breakpoint
CREATE TABLE `venues` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season_id` integer NOT NULL,
	`title` text NOT NULL,
	`address` text,
	`latitude` real,
	`longitude` real,
	`notes` text,
	`host_contact_id` integer,
	`placeholder` integer DEFAULT false NOT NULL,
	`reach_via_contact_id` integer,
	`canonical_venue_id` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`host_contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reach_via_contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`canonical_venue_id`) REFERENCES `venues`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `venues_season_id_idx` ON `venues` (`season_id`);