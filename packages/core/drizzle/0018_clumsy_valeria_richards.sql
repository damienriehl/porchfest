CREATE TABLE `participant_magic_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`record_type` text NOT NULL,
	`record_id` integer NOT NULL,
	`contact_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`activated_at` integer,
	`is_reissue` integer DEFAULT false NOT NULL,
	`revoked_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "participant_magic_links_record_type_check" CHECK("participant_magic_links"."record_type" in ('act', 'venue'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `participant_magic_links_token_hash_uidx` ON `participant_magic_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `participant_magic_links_target_idx` ON `participant_magic_links` (`record_type`,`record_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `participant_magic_links_contact_id_idx` ON `participant_magic_links` (`contact_id`);--> statement-breakpoint
CREATE TRIGGER `participant_magic_links_revoke_withdrawn_act`
AFTER UPDATE OF `status`, `canonical_act_id` ON `acts`
WHEN NEW.`status` = 'withdrawn' OR NEW.`canonical_act_id` IS NOT NULL
BEGIN
	UPDATE `participant_magic_links`
	SET `revoked_at` = unixepoch(), `updated_at` = unixepoch(), `version` = `version` + 1
	WHERE `record_type` = 'act' AND `record_id` = NEW.`id` AND `revoked_at` IS NULL;
END;--> statement-breakpoint
CREATE TRIGGER `participant_magic_links_revoke_withdrawn_venue`
AFTER UPDATE OF `status`, `canonical_venue_id` ON `venues`
WHEN NEW.`status` = 'withdrawn' OR NEW.`canonical_venue_id` IS NOT NULL
BEGIN
	UPDATE `participant_magic_links`
	SET `revoked_at` = unixepoch(), `updated_at` = unixepoch(), `version` = `version` + 1
	WHERE `record_type` = 'venue' AND `record_id` = NEW.`id` AND `revoked_at` IS NULL;
END;--> statement-breakpoint
CREATE TRIGGER `participant_magic_links_revoke_superseded_contact`
AFTER UPDATE OF `canonical_contact_id` ON `contacts`
WHEN NEW.`canonical_contact_id` IS NOT NULL
BEGIN
	UPDATE `participant_magic_links`
	SET `revoked_at` = unixepoch(), `updated_at` = unixepoch(), `version` = `version` + 1
	WHERE `contact_id` = NEW.`id` AND `revoked_at` IS NULL;
END;
