CREATE TABLE `import_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season_id` integer NOT NULL,
	`source` text NOT NULL,
	`natural_key` text NOT NULL,
	`record_type` text NOT NULL,
	`record_id` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_keys_season_source_natural_key_uidx` ON `import_keys` (`season_id`,`source`,`natural_key`);--> statement-breakpoint
CREATE INDEX `import_keys_record_idx` ON `import_keys` (`record_type`,`record_id`);--> statement-breakpoint
CREATE INDEX `import_keys_source_natural_type_idx` ON `import_keys` (`source`,`natural_key`,`record_type`);--> statement-breakpoint
DROP INDEX `annotations_season_id_idx`;--> statement-breakpoint
CREATE INDEX `annotations_season_record_note_idx` ON `annotations` (`season_id`,`record_type`,`record_id`,`note`);