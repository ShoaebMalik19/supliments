-- Tenant order ingest opens review items for its own org (policy WITH CHECK org_id = current_org_id()).
GRANT INSERT ON review_queue_items TO app_user;
