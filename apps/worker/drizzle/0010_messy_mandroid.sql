CREATE TABLE `pieces` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`problem_id` text,
	`idea_id` text,
	`type` text NOT NULL,
	`format` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`sections` text,
	`model` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`problem_id`) REFERENCES `problems`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`idea_id`) REFERENCES `article_ideas`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `pieces_project_id_idx` ON `pieces` (`project_id`);