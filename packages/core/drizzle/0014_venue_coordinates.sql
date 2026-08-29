CREATE TABLE `venue_coordinates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`venue_id` integer NOT NULL,
	`latitude` real,
	`longitude` real,
	`source` text NOT NULL,
	`precision` text,
	`provider` text NOT NULL,
	`ref` text,
	`cross_check_distance_m` real,
	`status` text NOT NULL,
	`rejection_code` text,
	`address_at_geocode` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_by` integer,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`venue_id`) REFERENCES `venues`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `organizers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "venue_coordinates_source_check" CHECK("venue_coordinates"."source" in ('geocoded', 'organizer-verified')),
	CONSTRAINT "venue_coordinates_precision_check" CHECK("venue_coordinates"."precision" is null or "venue_coordinates"."precision" in ('parcel', 'house', 'street')),
	CONSTRAINT "venue_coordinates_status_check" CHECK("venue_coordinates"."status" in ('verified', 'needs-review', 'rejected', 'pending')),
	CONSTRAINT "venue_coordinates_rejection_code_check" CHECK("venue_coordinates"."rejection_code" is null or "venue_coordinates"."rejection_code" in ('invalid-coordinate', 'missing-ref', 'interpolated', 'imprecise', 'out-of-bounds', 'cross-check-missing', 'cross-check-distance', 'address-changed', 'not-found', 'refused')),
	CONSTRAINT "venue_coordinates_point_pair_check" CHECK(("venue_coordinates"."latitude" is null and "venue_coordinates"."longitude" is null) or ("venue_coordinates"."latitude" is not null and "venue_coordinates"."longitude" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `venue_coordinates_venue_id_uidx` ON `venue_coordinates` (`venue_id`);--> statement-breakpoint
CREATE INDEX `venue_coordinates_status_idx` ON `venue_coordinates` (`status`);--> statement-breakpoint
INSERT INTO `venue_coordinates` (`venue_id`, `latitude`, `longitude`, `source`, `provider`, `status`, `rejection_code`, `address_at_geocode`, `updated_at`)
SELECT `id`,
	CASE WHEN `latitude` IS NOT NULL AND `longitude` IS NOT NULL THEN `latitude` ELSE NULL END,
	CASE WHEN `latitude` IS NOT NULL AND `longitude` IS NOT NULL THEN `longitude` ELSE NULL END,
	'geocoded',
	'legacy',
	CASE WHEN `latitude` IS NOT NULL AND `longitude` IS NOT NULL THEN 'pending' ELSE 'needs-review' END,
	CASE WHEN `latitude` IS NOT NULL AND `longitude` IS NOT NULL THEN NULL ELSE 'invalid-coordinate' END,
	coalesce(`address`, ''),
	`updated_at`
FROM `venues`
WHERE `latitude` IS NOT NULL OR `longitude` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `venues` DROP COLUMN `latitude`;--> statement-breakpoint
ALTER TABLE `venues` DROP COLUMN `longitude`;
