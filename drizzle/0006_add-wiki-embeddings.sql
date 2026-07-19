CREATE TABLE IF NOT EXISTS `ext_wiki_embeddings` (
	`content_hash` text PRIMARY KEY NOT NULL,
	`embedding` text NOT NULL,
	`model` text NOT NULL,
	`dimension` integer NOT NULL,
	`created_at` integer NOT NULL
);
