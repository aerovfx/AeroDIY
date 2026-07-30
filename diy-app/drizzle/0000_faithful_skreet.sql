CREATE TABLE `builds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_key` text NOT NULL,
	`name` text NOT NULL,
	`budget_cap` real,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`part_id` text NOT NULL,
	`qty` integer NOT NULL,
	`unit_price` real NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`build_id` integer NOT NULL,
	`vendor_name` text NOT NULL,
	`ordered_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`received_at` text,
	`tracking_number` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`shipping_cost` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`build_id`) REFERENCES `builds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `vendor_prices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_key` text NOT NULL,
	`part_id` text NOT NULL,
	`vendor_name` text NOT NULL,
	`url` text DEFAULT '' NOT NULL,
	`price` real NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`in_stock` integer DEFAULT true NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`checked_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
