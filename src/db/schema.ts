// 结构迁移。只追加新版本，不改旧版本。时间一律存毫秒时间戳。
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE incident (
  id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', occurred_at INTEGER, channel TEXT NOT NULL DEFAULT '微信',
  background TEXT NOT NULL DEFAULT '', severity INTEGER NOT NULL DEFAULT 3, status TEXT NOT NULL DEFAULT 'draft',
  my_feelings TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE message (
  id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incident(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, speaker TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', msg_type TEXT NOT NULL DEFAULT 'text',
  reply_to TEXT NOT NULL DEFAULT '', sent_at TEXT NOT NULL DEFAULT '', is_key INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 1, dup_suspect INTEGER NOT NULL DEFAULT 0, attachment_id TEXT
);
CREATE INDEX idx_message_incident ON message(incident_id, seq);
CREATE TABLE attachment (
  id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incident(id) ON DELETE CASCADE,
  data_url TEXT NOT NULL, order_no INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE analysis (
  id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incident(id) ON DELETE CASCADE,
  data TEXT NOT NULL, my_own_words TEXT NOT NULL DEFAULT '', profile_name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE rule (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, trigger_scene TEXT NOT NULL DEFAULT '', good_example TEXT NOT NULL DEFAULT '',
  bad_example TEXT NOT NULL DEFAULT '', my_own_words TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active', occurrence_count INTEGER NOT NULL DEFAULT 1,
  first_seen INTEGER, last_seen INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE rule_evidence (
  id TEXT PRIMARY KEY, rule_id TEXT NOT NULL REFERENCES rule(id) ON DELETE CASCADE,
  incident_id TEXT NOT NULL REFERENCES incident(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', message_id TEXT
);
CREATE INDEX idx_evidence_rule ON rule_evidence(rule_id);
CREATE TABLE tag (name TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '', builtin INTEGER NOT NULL DEFAULT 0);
CREATE TABLE review_card (
  rule_id TEXT PRIMARY KEY REFERENCES rule(id) ON DELETE CASCADE,
  due INTEGER NOT NULL, stability REAL NOT NULL DEFAULT 0, difficulty REAL NOT NULL DEFAULT 0,
  elapsed_days REAL NOT NULL DEFAULT 0, scheduled_days REAL NOT NULL DEFAULT 0, learning_steps INTEGER NOT NULL DEFAULT 0,
  reps INTEGER NOT NULL DEFAULT 0, lapses INTEGER NOT NULL DEFAULT 0, state INTEGER NOT NULL DEFAULT 0,
  last_review INTEGER, ebb_step INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_card_due ON review_card(due);
CREATE TABLE review_log (
  id TEXT PRIMARY KEY, rule_id TEXT NOT NULL REFERENCES rule(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL, ai_score REAL, source TEXT NOT NULL DEFAULT 'review',
  reviewed_at INTEGER NOT NULL, session_id TEXT
);
CREATE INDEX idx_log_time ON review_log(reviewed_at);
CREATE TABLE quiz_item (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, rule_id TEXT, kind TEXT NOT NULL, scenario_key TEXT NOT NULL DEFAULT '',
  question TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '', grade TEXT NOT NULL DEFAULT '', score REAL,
  chat TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
);
CREATE INDEX idx_quiz_rule ON quiz_item(rule_id, created_at);
CREATE TABLE commitment (
  id TEXT PRIMARY KEY, content TEXT NOT NULL, promised_at INTEGER, due_at INTEGER, status TEXT NOT NULL DEFAULT 'open',
  incident_id TEXT, done_note TEXT NOT NULL DEFAULT '', cancel_reason TEXT NOT NULL DEFAULT '',
  told_her INTEGER NOT NULL DEFAULT 0, overdue_logged INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE model_profile (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, protocol TEXT NOT NULL DEFAULT 'openai', base_url TEXT NOT NULL,
  model TEXT NOT NULL, supports_vision INTEGER NOT NULL DEFAULT 0, supports_json INTEGER NOT NULL DEFAULT 1,
  temperature REAL, max_tokens INTEGER NOT NULL DEFAULT 4096, timeout_s INTEGER NOT NULL DEFAULT 120,
  needs_key INTEGER NOT NULL DEFAULT 1, quirks TEXT NOT NULL DEFAULT '{}', price_in REAL, price_out REAL,
  created_at INTEGER NOT NULL
);
CREATE TABLE ai_call_log (
  id TEXT PRIMARY KEY, task TEXT NOT NULL, profile_name TEXT NOT NULL, model TEXT NOT NULL,
  input_tokens INTEGER, output_tokens INTEGER, latency_ms INTEGER, ok INTEGER NOT NULL, error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE setting (k TEXT PRIMARY KEY, v TEXT NOT NULL)
`,
  },
]
