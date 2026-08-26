-- Account credentials changed from 4-6 digit PINs to minimum-6-character
-- passwords, still stored as salted scrypt hashes (see
-- apps/api/src/security/passwordHash.ts for the format).
-- Column rename only: pre-existing pin_hash values were derived from shorter
-- PINs and no longer correspond to a valid password, so dev databases should
-- be reseeded afterwards.

ALTER TABLE customers RENAME COLUMN pin_hash TO password_hash;
ALTER TABLE merchants RENAME COLUMN pin_hash TO password_hash;
