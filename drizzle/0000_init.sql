CREATE TABLE `agent_articles` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` integer NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`input` text NOT NULL,
	`state` text NOT NULL,
	`content_markdown` text DEFAULT '' NOT NULL,
	`word_count` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`error` text,
	`control` text,
	`lease_token` text,
	`lease_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`published_at` integer,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `agent_articles_updated_idx` ON `agent_articles` (`updated_at`);--> statement-breakpoint
CREATE INDEX `agent_articles_status_idx` ON `agent_articles` (`status`);--> statement-breakpoint
CREATE TABLE `agent_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`article_id` text NOT NULL,
	`mime_type` text NOT NULL,
	`data` blob NOT NULL,
	FOREIGN KEY (`article_id`) REFERENCES `agent_articles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_assets_article_idx` ON `agent_assets` (`article_id`);--> statement-breakpoint
CREATE TABLE `agent_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`article_id` text NOT NULL,
	`agent` text NOT NULL,
	`run_id` text NOT NULL,
	`message` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`article_id`) REFERENCES `agent_articles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_messages_run_idx` ON `agent_messages` (`article_id`,`agent`,`run_id`);--> statement-breakpoint
CREATE TABLE `product_pages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`url` text NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_pages_product_url_idx` ON `product_pages` (`product_id`,`url`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`website_settings` text NOT NULL,
	`publishing` text,
	`index_queue` text DEFAULT '[]' NOT NULL,
	`index_status` text DEFAULT 'idle' NOT NULL,
	`index_error` text,
	`indexed_at` integer,
	`content_updated_at` text NOT NULL,
	`created_at` integer NOT NULL
);
