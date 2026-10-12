CREATE TABLE `payment_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`spot_id` text NOT NULL,
	`owner` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`amount_paise` integer DEFAULT 1500 NOT NULL,
	`submitted_ref` text,
	`receipt_ref` text,
	`pass_code` text,
	`verified_by` text,
	`verified_at` integer,
	`created_at` integer NOT NULL,
	`lifecycle` text DEFAULT 'active' NOT NULL,
	`note` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_requests_receipt_ref_unique` ON `payment_requests` (`receipt_ref`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_requests_pass_code_unique` ON `payment_requests` (`pass_code`);