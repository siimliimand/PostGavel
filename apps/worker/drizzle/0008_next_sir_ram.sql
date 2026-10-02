CREATE TABLE `problems` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`search_signals` text,
	`source` text DEFAULT 'ai' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `article_ideas` ADD `problem_id` text REFERENCES problems(id) ON DELETE set null;