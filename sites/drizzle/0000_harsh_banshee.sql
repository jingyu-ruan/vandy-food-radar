CREATE TABLE `app_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `conflicts` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`feed_date` text NOT NULL,
	`field_name` text NOT NULL,
	`competing_values` text NOT NULL,
	`resolution` text
);
--> statement-breakpoint
CREATE INDEX `conflicts_event_idx` ON `conflicts` (`event_id`);--> statement-breakpoint
CREATE INDEX `conflicts_feed_idx` ON `conflicts` (`feed_date`);--> statement-breakpoint
CREATE TABLE `event_changes` (
	`feed_date` text NOT NULL,
	`identity_key` text NOT NULL,
	`kind` text NOT NULL,
	`detail` text,
	`detected_at` text NOT NULL,
	PRIMARY KEY(`feed_date`, `identity_key`)
);
--> statement-breakpoint
CREATE TABLE `event_history` (
	`id` text PRIMARY KEY NOT NULL,
	`identity_key` text NOT NULL,
	`feed_date` text NOT NULL,
	`changed_at` text NOT NULL,
	`field_name` text NOT NULL,
	`old_value` text,
	`new_value` text,
	`reason` text
);
--> statement-breakpoint
CREATE INDEX `event_history_identity_idx` ON `event_history` (`identity_key`);--> statement-breakpoint
CREATE INDEX `event_history_changed_idx` ON `event_history` (`changed_at`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`feed_date` text NOT NULL,
	`identity_key` text NOT NULL,
	`dedup_key` text NOT NULL,
	`anchorlink_id` text,
	`title` text NOT NULL,
	`event_date` text NOT NULL,
	`start_time` text,
	`end_time` text,
	`start_utc` text,
	`end_utc` text,
	`ends_next_day` integer DEFAULT 0 NOT NULL,
	`location` text,
	`organizer` text,
	`rsvp_required` integer,
	`rsvp_url` text,
	`rsvp_link_ok` integer,
	`event_url` text,
	`food_confirmed` text NOT NULL,
	`food_category` text NOT NULL,
	`food_description` text,
	`verification_state` text NOT NULL,
	`confidence` real,
	`score_total` real,
	`explanation` text,
	`walking_label` text NOT NULL,
	`rank` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_feed_date_idx` ON `events` (`feed_date`);--> statement-breakpoint
CREATE INDEX `events_anchorlink_id_idx` ON `events` (`anchorlink_id`);--> statement-breakpoint
CREATE INDEX `events_feed_identity_idx` ON `events` (`feed_date`,`identity_key`);--> statement-breakpoint
CREATE TABLE `feeds` (
	`target_date` text PRIMARY KEY NOT NULL,
	`timezone` text NOT NULL,
	`target_window` text NOT NULL,
	`event_count` integer NOT NULL,
	`published_at` text NOT NULL,
	`source_total` integer DEFAULT 0 NOT NULL,
	`pages_fetched` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `field_provenance` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`feed_date` text NOT NULL,
	`field_name` text NOT NULL,
	`chosen_value` text,
	`chosen_source_id` text,
	`agreement` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `field_provenance_event_idx` ON `field_provenance` (`event_id`);--> statement-breakpoint
CREATE INDEX `field_provenance_feed_idx` ON `field_provenance` (`feed_date`);--> statement-breakpoint
CREATE TABLE `refresh_lease` (
	`name` text PRIMARY KEY NOT NULL,
	`holder` text NOT NULL,
	`acquired_at` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `refresh_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`target_date` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`trigger` text NOT NULL,
	`fetched` integer DEFAULT 0 NOT NULL,
	`published` integer DEFAULT 0 NOT NULL,
	`pages_fetched` integer DEFAULT 0 NOT NULL,
	`changes_json` text,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `refresh_runs_finished_idx` ON `refresh_runs` (`finished_at`);--> statement-breakpoint
CREATE TABLE `score_components` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`feed_date` text NOT NULL,
	`factor` text NOT NULL,
	`raw_value` real,
	`weight` real NOT NULL,
	`contribution` real NOT NULL,
	`note` text,
	`position` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `score_components_event_idx` ON `score_components` (`event_id`);--> statement-breakpoint
CREATE INDEX `score_components_feed_idx` ON `score_components` (`feed_date`);--> statement-breakpoint
CREATE TABLE `source_records` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`feed_date` text NOT NULL,
	`source_id` text NOT NULL,
	`source_url` text,
	`raw_payload` text,
	`parsed_fields` text,
	`checked_at` text,
	`parse_status` text NOT NULL,
	`source_updated_at` text
);
--> statement-breakpoint
CREATE INDEX `source_records_event_idx` ON `source_records` (`event_id`);--> statement-breakpoint
CREATE INDEX `source_records_feed_idx` ON `source_records` (`feed_date`);