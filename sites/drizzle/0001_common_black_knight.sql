DROP INDEX `events_feed_identity_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `events_feed_identity_idx` ON `events` (`feed_date`,`identity_key`);