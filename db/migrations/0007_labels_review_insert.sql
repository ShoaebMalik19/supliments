-- Submitting a label opens its review item in the same tenant transaction. Tenants may only
-- insert (for their own org, via the tenant_isolation policy); status changes stay privileged.
GRANT INSERT ON review_queue_items TO app_user;
