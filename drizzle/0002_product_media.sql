CREATE TABLE `product_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` integer NOT NULL,
	`mime_type` text NOT NULL,
	`data` blob NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `product_assets_product_idx` ON `product_assets` (`product_id`);--> statement-breakpoint
ALTER TABLE `products` ADD `site_media` text;