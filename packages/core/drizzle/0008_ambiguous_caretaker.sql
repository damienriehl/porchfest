CREATE TABLE `queue_dismissals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organizer_id` integer NOT NULL,
	`season_id` integer NOT NULL,
	`record_type` text NOT NULL,
	`record_id` integer NOT NULL,
	`dismissed_version` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`organizer_id`) REFERENCES `organizers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "queue_dismissals_record_type_check" CHECK("queue_dismissals"."record_type" in ('act', 'venue', 'contact'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `queue_dismissals_organizer_record_uidx` ON `queue_dismissals` (`organizer_id`,`record_type`,`record_id`);--> statement-breakpoint
CREATE INDEX `queue_dismissals_season_idx` ON `queue_dismissals` (`season_id`);