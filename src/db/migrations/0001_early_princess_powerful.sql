CREATE TABLE `peer_identities` (
	`device_id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`public_signing_key` text NOT NULL,
	`service_name` text,
	`host` text NOT NULL,
	`port` integer NOT NULL,
	`status` text DEFAULT 'ONLINE' NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `peer_identities_status_idx` ON `peer_identities` (`status`,`last_seen_at`);--> statement-breakpoint
CREATE TABLE `peer_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`peer_device_id` text NOT NULL,
	`peer_display_name` text NOT NULL,
	`peer_public_key` text NOT NULL,
	`peer_address` text NOT NULL,
	`peer_port` integer NOT NULL,
	`direction` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`last_activity_at` integer NOT NULL,
	`ended_at` integer,
	`events_sent` integer DEFAULT 0 NOT NULL,
	`events_received` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `peer_sessions_peer_idx` ON `peer_sessions` (`peer_device_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `peer_sessions_status_idx` ON `peer_sessions` (`status`,`last_activity_at`);--> statement-breakpoint
CREATE TABLE `sync_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`level` text NOT NULL,
	`category` text NOT NULL,
	`peer_device_id` text,
	`session_id` text,
	`message` text NOT NULL,
	`details_json` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sync_logs_created_idx` ON `sync_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `sync_logs_peer_idx` ON `sync_logs` (`peer_device_id`,`created_at`);