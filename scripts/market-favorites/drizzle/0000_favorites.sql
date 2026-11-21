CREATE TABLE `market_favorites` (
  `plugin_id` text NOT NULL,
  `installation_hash` text NOT NULL,
  PRIMARY KEY (`plugin_id`, `installation_hash`)
);
