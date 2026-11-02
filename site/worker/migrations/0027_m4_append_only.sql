-- M4: counter-notice restores + append-only enforcement for every M4 table (0021-0027).
-- A restore re-shows an event hidden by one notice. It is a new row, never a delete; hash-only (the counter-notice and
-- its sender are stored only as sha256). Written by hand via site/scripts/km-takedown.py after a person reviews it.
CREATE TABLE IF NOT EXISTS takedown_restores (
  event_id TEXT NOT NULL,
  notice_hash TEXT NOT NULL,      -- the notice whose hide this reverses
  counter_hash TEXT NOT NULL,     -- sha256 of the counter-notice as received
  restored_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, notice_hash)
);
CREATE TRIGGER IF NOT EXISTS snapshot_nodes_no_update BEFORE UPDATE ON snapshot_nodes BEGIN SELECT RAISE(ABORT, 'snapshot_nodes is append-only'); END;
CREATE TRIGGER IF NOT EXISTS snapshot_nodes_no_delete BEFORE DELETE ON snapshot_nodes BEGIN SELECT RAISE(ABORT, 'snapshot_nodes is append-only'); END;
CREATE TRIGGER IF NOT EXISTS snapshot_leaves_no_update BEFORE UPDATE ON snapshot_leaves BEGIN SELECT RAISE(ABORT, 'snapshot_leaves is append-only'); END;
CREATE TRIGGER IF NOT EXISTS snapshot_leaves_no_delete BEFORE DELETE ON snapshot_leaves BEGIN SELECT RAISE(ABORT, 'snapshot_leaves is append-only'); END;
CREATE TRIGGER IF NOT EXISTS store_trust_obs_no_update BEFORE UPDATE ON store_trust_obs BEGIN SELECT RAISE(ABORT, 'store_trust_obs is append-only'); END;
CREATE TRIGGER IF NOT EXISTS store_trust_obs_no_delete BEFORE DELETE ON store_trust_obs BEGIN SELECT RAISE(ABORT, 'store_trust_obs is append-only'); END;
CREATE TRIGGER IF NOT EXISTS live_seen_domains_no_update BEFORE UPDATE ON live_seen_domains BEGIN SELECT RAISE(ABORT, 'live_seen_domains is append-only'); END;
CREATE TRIGGER IF NOT EXISTS live_seen_domains_no_delete BEFORE DELETE ON live_seen_domains BEGIN SELECT RAISE(ABORT, 'live_seen_domains is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ship_policy_obs_no_update BEFORE UPDATE ON ship_policy_obs BEGIN SELECT RAISE(ABORT, 'ship_policy_obs is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ship_policy_obs_no_delete BEFORE DELETE ON ship_policy_obs BEGIN SELECT RAISE(ABORT, 'ship_policy_obs is append-only'); END;
CREATE TRIGGER IF NOT EXISTS takedown_notices_no_update BEFORE UPDATE ON takedown_notices BEGIN SELECT RAISE(ABORT, 'takedown_notices is append-only'); END;
CREATE TRIGGER IF NOT EXISTS takedown_notices_no_delete BEFORE DELETE ON takedown_notices BEGIN SELECT RAISE(ABORT, 'takedown_notices is append-only'); END;
CREATE TRIGGER IF NOT EXISTS takedown_hides_no_update BEFORE UPDATE ON takedown_hides BEGIN SELECT RAISE(ABORT, 'takedown_hides is append-only'); END;
CREATE TRIGGER IF NOT EXISTS takedown_hides_no_delete BEFORE DELETE ON takedown_hides BEGIN SELECT RAISE(ABORT, 'takedown_hides is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trust_buys_no_update BEFORE UPDATE ON trust_buys BEGIN SELECT RAISE(ABORT, 'trust_buys is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trust_buys_no_delete BEFORE DELETE ON trust_buys BEGIN SELECT RAISE(ABORT, 'trust_buys is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trust_complaints_no_update BEFORE UPDATE ON trust_complaints BEGIN SELECT RAISE(ABORT, 'trust_complaints is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trust_complaints_no_delete BEFORE DELETE ON trust_complaints BEGIN SELECT RAISE(ABORT, 'trust_complaints is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trust_dismissals_no_update BEFORE UPDATE ON trust_dismissals BEGIN SELECT RAISE(ABORT, 'trust_dismissals is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trust_dismissals_no_delete BEFORE DELETE ON trust_dismissals BEGIN SELECT RAISE(ABORT, 'trust_dismissals is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trust_graph_heads_no_update BEFORE UPDATE ON trust_graph_heads BEGIN SELECT RAISE(ABORT, 'trust_graph_heads is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trust_graph_heads_no_delete BEFORE DELETE ON trust_graph_heads BEGIN SELECT RAISE(ABORT, 'trust_graph_heads is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trust_graph_members_no_update BEFORE UPDATE ON trust_graph_members BEGIN SELECT RAISE(ABORT, 'trust_graph_members is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trust_graph_members_no_delete BEFORE DELETE ON trust_graph_members BEGIN SELECT RAISE(ABORT, 'trust_graph_members is append-only'); END;
CREATE TRIGGER IF NOT EXISTS takedown_restores_no_update BEFORE UPDATE ON takedown_restores BEGIN SELECT RAISE(ABORT, 'takedown_restores is append-only'); END;
CREATE TRIGGER IF NOT EXISTS takedown_restores_no_delete BEFORE DELETE ON takedown_restores BEGIN SELECT RAISE(ABORT, 'takedown_restores is append-only'); END;
