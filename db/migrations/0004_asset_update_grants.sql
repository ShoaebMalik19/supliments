-- Tenants may only advance an asset's verification state; bucket, key, org, kind, mime and
-- declared size are immutable after the upload is issued.
REVOKE UPDATE ON assets FROM app_user;
--> statement-breakpoint
GRANT UPDATE (upload_status, width, height, checksum) ON assets TO app_user;
