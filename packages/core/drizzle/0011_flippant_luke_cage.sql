CREATE TABLE `deletion_receipts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`contact_id` integer NOT NULL,
	`action` text NOT NULL,
	`application_anonymized_at` integer NOT NULL,
	`backup_status` text DEFAULT 'pending' NOT NULL,
	`backup_completed_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deletion_receipts_contact_id_uidx` ON `deletion_receipts` (`contact_id`);--> statement-breakpoint
CREATE INDEX `deletion_receipts_backup_status_idx` ON `deletion_receipts` (`backup_status`);