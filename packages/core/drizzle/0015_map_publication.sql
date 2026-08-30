ALTER TABLE `seasons` ADD `event_city` text DEFAULT 'Unconfigured' NOT NULL;--> statement-breakpoint
ALTER TABLE `seasons` ADD `event_state` text DEFAULT 'Unconfigured' NOT NULL;--> statement-breakpoint
ALTER TABLE `seasons` ADD `map_published_at` integer;