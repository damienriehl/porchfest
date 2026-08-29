CREATE TABLE `outbox_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season_id` integer NOT NULL,
	`wave_id` integer NOT NULL,
	`record_type` text NOT NULL,
	`record_id` integer NOT NULL,
	`state` text DEFAULT 'generated' NOT NULL,
	`subject` text NOT NULL,
	`text_body` text,
	`html_body` text,
	`source_fingerprint` text NOT NULL,
	`pre_send_state` text,
	`sent_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`wave_id`) REFERENCES `outbox_waves`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "outbox_messages_record_type_check" CHECK("outbox_messages"."record_type" in ('venue', 'act', 'contact')),
	CONSTRAINT "outbox_messages_state_check" CHECK("outbox_messages"."state" in ('generated', 'edited', 'sent', 'generated_stale', 'edited_stale'))
);
--> statement-breakpoint
CREATE INDEX `outbox_messages_season_id_idx` ON `outbox_messages` (`season_id`);--> statement-breakpoint
CREATE INDEX `outbox_messages_wave_id_idx` ON `outbox_messages` (`wave_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_messages_wave_record_uidx` ON `outbox_messages` (`wave_id`,`record_type`,`record_id`);--> statement-breakpoint
CREATE TABLE `outbox_recipients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season_id` integer NOT NULL,
	`message_id` integer NOT NULL,
	`contact_id` integer NOT NULL,
	`address` text NOT NULL,
	`previous_address` text,
	`sent_at` integer,
	`outcome` text,
	`provider_message_id` text,
	`reason` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `outbox_messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "outbox_recipients_outcome_check" CHECK("outbox_recipients"."outcome" is null or "outbox_recipients"."outcome" in ('sent', 'skipped', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `outbox_recipients_season_id_idx` ON `outbox_recipients` (`season_id`);--> statement-breakpoint
CREATE INDEX `outbox_recipients_message_id_idx` ON `outbox_recipients` (`message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_recipients_message_contact_uidx` ON `outbox_recipients` (`message_id`,`contact_id`);--> statement-breakpoint
CREATE TABLE `outbox_waves` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season_id` integer NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`subject_template` text NOT NULL,
	`body_template` text NOT NULL,
	`recipient_rule` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "outbox_waves_kind_check" CHECK("outbox_waves"."kind" in ('thank_you', 'match', 'reminder_7day', 'day_of', 'post_event', 'ad_hoc')),
	CONSTRAINT "outbox_waves_recipient_rule_check" CHECK("outbox_waves"."recipient_rule" in ('matched_venues', 'unmatched_venues', 'unmatched_acts', 'all_participants', 'manual')),
	CONSTRAINT "outbox_waves_status_check" CHECK("outbox_waves"."status" in ('open', 'complete'))
);
--> statement-breakpoint
CREATE INDEX `outbox_waves_season_id_idx` ON `outbox_waves` (`season_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_waves_season_label_uidx` ON `outbox_waves` (`season_id`,`label`);--> statement-breakpoint
ALTER TABLE `email_log` ADD `address` text;--> statement-breakpoint
ALTER TABLE `email_log` ADD `outcome` text;--> statement-breakpoint
ALTER TABLE `email_log` ADD `message_id` integer;