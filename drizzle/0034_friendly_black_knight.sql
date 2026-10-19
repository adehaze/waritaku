DROP INDEX IF EXISTS `entries_author_collection_status_idx`;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `entries_author_collection_status_id_idx` ON `entries` (`author_id`,`collection_id`,`status`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `entry_terms_term_idx`;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `entry_terms_term_entry_idx` ON `entry_terms` (`term_id`,`entry_id`);