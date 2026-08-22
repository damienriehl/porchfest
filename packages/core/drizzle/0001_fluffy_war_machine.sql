CREATE TABLE `email_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season_id` integer NOT NULL,
	`record_type` text NOT NULL,
	`record_id` integer NOT NULL,
	`wave_label` text NOT NULL,
	`recipient_contact_id` integer NOT NULL,
	`sent_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipient_contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `email_log_season_id_idx` ON `email_log` (`season_id`);--> statement-breakpoint
CREATE INDEX `email_log_record_idx` ON `email_log` (`record_type`,`record_id`);--> statement-breakpoint
CREATE INDEX `email_log_recipient_contact_id_idx` ON `email_log` (`recipient_contact_id`);