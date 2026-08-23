CREATE TABLE `change_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season_id` integer NOT NULL,
	`record_type` text NOT NULL,
	`record_id` integer NOT NULL,
	`record_version` integer NOT NULL,
	`kind` text NOT NULL,
	`proposed_value` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `change_requests_season_status_idx` ON `change_requests` (`season_id`,`status`);--> statement-breakpoint
CREATE INDEX `change_requests_target_idx` ON `change_requests` (`record_type`,`record_id`);