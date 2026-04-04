CREATE TABLE IF NOT EXISTS `participants_rooms` (
    `id` char(36) NOT NULL,
    `channel_id` char(36) NOT NULL,
    `plugin_room_id` char(36) NOT NULL,
    `host_member_id` varchar(255) NOT NULL,
    `host_username` varchar(255) NOT NULL,
    `status` varchar(20) NOT NULL DEFAULT 'open',
    `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` timestamp NULL,
    PRIMARY KEY (`id`),
    KEY `participants_rooms_channel_id_index` (`channel_id`),
    KEY `participants_rooms_host_member_id_index` (`host_member_id`)
);

CREATE TABLE IF NOT EXISTS `participants_invites` (
    `id` char(36) NOT NULL,
    `room_id` char(36) NOT NULL,
    `channel_id` char(36) NOT NULL,
    `invited_member_id` varchar(255) NOT NULL,
    `invited_username` varchar(255) NOT NULL,
    `host_member_id` varchar(255) NOT NULL,
    `host_username` varchar(255) NOT NULL,
    `status` varchar(20) NOT NULL DEFAULT 'pending',
    `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `participants_invites_room_member_unique` (`room_id`, `invited_member_id`),
    KEY `participants_invites_invited_member_id_index` (`invited_member_id`)
);
