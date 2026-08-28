CREATE TABLE `act_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season_id` integer NOT NULL,
	`act_id` integer NOT NULL,
	`linked_act_id` integer NOT NULL,
	`note` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`act_id`) REFERENCES `acts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`linked_act_id`) REFERENCES `acts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "act_links_normalized_check" CHECK("act_links"."act_id" < "act_links"."linked_act_id")
);
--> statement-breakpoint
CREATE INDEX `act_links_season_id_idx` ON `act_links` (`season_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `act_links_act_id_linked_act_id_uidx` ON `act_links` (`act_id`,`linked_act_id`);--> statement-breakpoint
ALTER TABLE `acts` ADD `shared_member_note` text;--> statement-breakpoint
ALTER TABLE `assignments` ADD `shared_member_override` text;--> statement-breakpoint
ALTER TABLE `venues` ADD `requested_act_names` text;--> statement-breakpoint
ALTER TABLE `venues` ADD `genre_preferences` text;