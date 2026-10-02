-- Reads are no longer permission-gated; drop the retired *:read grants from custom roles.
DELETE FROM `role_permissions` WHERE `permission` LIKE '%:read';
