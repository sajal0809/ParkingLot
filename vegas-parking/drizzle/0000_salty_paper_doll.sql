CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`spot_id` text NOT NULL,
	`action` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `spots` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'available' NOT NULL,
	`booking_id` text,
	`owner` text,
	`name` text,
	`vehicle` text,
	`created_at` integer,
	`version` integer DEFAULT 0 NOT NULL
);
