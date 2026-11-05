PRAGMA journal_mode = WAL;--> statement-breakpoint
PRAGMA foreign_keys = ON;--> statement-breakpoint
CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`lead_device_id` text NOT NULL,
	`genesis_event_id` text NOT NULL,
	`key_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `device_identity` (
	`device_id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`public_signing_key` text NOT NULL,
	`keystore_alias` text NOT NULL,
	`lamport_clock` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`author_device_id` text NOT NULL,
	`author_sequence` integer NOT NULL,
	`lamport_clock` integer NOT NULL,
	`type` text NOT NULL,
	`entity_id` text,
	`key_version` integer NOT NULL,
	`ciphertext` text,
	`payload_json` text NOT NULL,
	`signature` text NOT NULL,
	`created_at` integer NOT NULL,
	`received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_author_sequence_uq` ON `events` (`channel_id`,`author_device_id`,`author_sequence`);--> statement-breakpoint
CREATE INDEX `events_channel_clock_idx` ON `events` (`channel_id`,`lamport_clock`);--> statement-breakpoint
CREATE TABLE `members` (
	`channel_id` text NOT NULL,
	`device_id` text NOT NULL,
	`display_name` text NOT NULL,
	`public_signing_key` text NOT NULL,
	`role` text NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`joined_event_id` text NOT NULL,
	`removed_event_id` text,
	PRIMARY KEY(`channel_id`, `device_id`)
);
--> statement-breakpoint
CREATE INDEX `members_channel_idx` ON `members` (`channel_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`kind` text NOT NULL,
	`author_device_id` text,
	`body` text NOT NULL,
	`source_event_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_source_event_uq` ON `messages` (`source_event_id`);--> statement-breakpoint
CREATE INDEX `messages_channel_created_idx` ON `messages` (`channel_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `peer_receipts` (
	`channel_id` text NOT NULL,
	`peer_device_id` text NOT NULL,
	`author_device_id` text NOT NULL,
	`highest_sequence` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`channel_id`, `peer_device_id`, `author_device_id`)
);
--> statement-breakpoint
CREATE TABLE `rejected_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text,
	`peer_device_id` text,
	`reason_code` text NOT NULL,
	`received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_field_versions` (
	`task_id` text NOT NULL,
	`field_name` text NOT NULL,
	`lamport_clock` integer NOT NULL,
	`actor_device_id` text NOT NULL,
	`event_id` text NOT NULL,
	PRIMARY KEY(`task_id`, `field_name`)
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`status` text NOT NULL,
	`priority` text NOT NULL,
	`assignee_device_id` text,
	`due_at` integer,
	`creator_device_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tasks_board_idx` ON `tasks` (`channel_id`,`archived`,`status`);--> statement-breakpoint
CREATE INDEX `tasks_assignee_idx` ON `tasks` (`channel_id`,`assignee_device_id`);
