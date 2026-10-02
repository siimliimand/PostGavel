CREATE TABLE `derivatives` (
	`id` text PRIMARY KEY NOT NULL,
	`draft_piece_id` text NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`model` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`draft_piece_id`) REFERENCES `pieces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `derivatives_draft_piece_id_kind_unique` ON `derivatives` (`draft_piece_id`,`kind`);--> statement-breakpoint
CREATE INDEX `derivatives_draft_piece_id_idx` ON `derivatives` (`draft_piece_id`);