-- Phase 7: Windows print agent.
ALTER TABLE agents ADD COLUMN version TEXT;
ALTER TABLE agents ADD COLUMN created_by TEXT;
ALTER TABLE print_jobs ADD COLUMN document_id TEXT REFERENCES documents(id);
ALTER TABLE print_jobs ADD COLUMN agent_id TEXT REFERENCES agents(id);
ALTER TABLE print_jobs ADD COLUMN leased_at TEXT;
ALTER TABLE print_jobs ADD COLUMN download_used_at TEXT;
ALTER TABLE print_jobs ADD COLUMN batch INTEGER NOT NULL DEFAULT 1;   -- 1 = first print, 2+ = reprints
ALTER TABLE print_jobs ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
CREATE INDEX print_jobs_lease ON print_jobs(status, lease_expires_at);
CREATE INDEX printers_agent ON printers(agent_id);
