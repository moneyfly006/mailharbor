/**
 * SQLite 建表 DDL（纯字符串，无 electron 依赖 → 可被单测直接用于 :memory: 数据库）。
 * 与 docs/ARCHITECTURE.md §4 对齐；时间一律 UTC 毫秒整数，布尔 0/1，JSON 存 TEXT。
 */
export const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  preset TEXT NOT NULL DEFAULT 'custom',
  email TEXT NOT NULL,
  display_name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending_test',
  imap_host TEXT NOT NULL, imap_port INTEGER NOT NULL, imap_secure TEXT NOT NULL DEFAULT 'ssl',
  imap_user TEXT NOT NULL, imap_pass_enc BLOB,
  smtp_host TEXT NOT NULL, smtp_port INTEGER NOT NULL, smtp_secure TEXT NOT NULL DEFAULT 'ssl',
  smtp_user TEXT NOT NULL, smtp_from_name TEXT, smtp_same_as_imap INTEGER NOT NULL DEFAULT 1, smtp_pass_enc BLOB,
  allow_self_signed INTEGER NOT NULL DEFAULT 0,
  spam_uid_validity TEXT, spam_last_uid INTEGER NOT NULL DEFAULT 0,
  send_only INTEGER NOT NULL DEFAULT 0,
  last_check_at INTEGER, last_ok_at INTEGER, last_error_code TEXT, last_error TEXT,
  uid_validity TEXT, last_uid INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(imap_host, imap_user)
);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  scope TEXT NOT NULL DEFAULT 'subject',
  mode TEXT NOT NULL DEFAULT 'exact',
  priority INTEGER NOT NULL DEFAULT 100,
  file_types TEXT NOT NULL DEFAULT '["zip","tif","tiff"]',
  auto_reply INTEGER NOT NULL DEFAULT 1,
  hit_messages INTEGER NOT NULL DEFAULT 0,
  hit_files INTEGER NOT NULL DEFAULT 0,
  last_hit_at INTEGER,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rule_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id INTEGER NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(rule_id, path)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  imap_uid INTEGER NOT NULL,
  provider_message_id TEXT,
  thread_key TEXT,
  rfc_message_id TEXT,
  subject TEXT,
  from_addr TEXT, from_name TEXT,
  received_at INTEGER,
  matched_rule_id INTEGER, matched_keyword TEXT,
  match_source TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  mailbox TEXT NOT NULL DEFAULT 'INBOX',
  reply_status TEXT NOT NULL DEFAULT 'pending',
  links TEXT,
  error TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(account_id, imap_uid)
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  part_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT,
  declared_size INTEGER,
  tmp_path TEXT, sha256 TEXT, size INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(message_id, part_id)
);

CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attachment_id INTEGER NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL,
  target_path TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  saved_path TEXT, saved_name TEXT, size INTEGER, sha256 TEXT,
  error_code TEXT, error TEXT,
  started_at INTEGER, finished_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(attachment_id, target_id)
);

CREATE TABLE IF NOT EXISTS auto_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL,
  thread_key TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  subject TEXT,
  body_preview TEXT,
  status TEXT NOT NULL,
  provider_message_id TEXT, error TEXT,
  sent_at INTEGER, created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_reply_thread_sent ON auto_replies(account_id, thread_key) WHERE status='sent';

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, level TEXT NOT NULL,
  scope TEXT, message TEXT NOT NULL, detail TEXT
);

CREATE INDEX IF NOT EXISTS ix_msgs_time ON messages(received_at DESC);
CREATE INDEX IF NOT EXISTS ix_msgs_status ON messages(status);
CREATE INDEX IF NOT EXISTS ix_msgs_account ON messages(account_id, imap_uid);
CREATE INDEX IF NOT EXISTS ix_dlv_queue ON deliveries(state, next_retry_at);
CREATE INDEX IF NOT EXISTS ix_dlv_msg ON deliveries(message_id);
CREATE INDEX IF NOT EXISTS ix_dlv_target ON deliveries(target_path);
CREATE INDEX IF NOT EXISTS ix_targets_rule ON rule_targets(rule_id);
CREATE INDEX IF NOT EXISTS ix_replies_acc ON auto_replies(account_id, created_at);
`
