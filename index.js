// \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esmMin = (fn, res, err) => () => {
	if (err) throw err[0];
	try {
		return fn && (res = fn(fn = 0)), res;
	} catch (e) {
		throw err = [e], e;
	}
};
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));
var __toCommonJS = (mod) => __hasOwnProp.call(mod, "module.exports") ? mod["module.exports"] : __copyProps(__defProp({}, "__esModule", { value: true }), mod);
let electron = require("electron");
let node_path = require("node:path");
let node_fs = require("node:fs");
let node_module = require("node:module");
let node_fs_promises = require("node:fs/promises");
let node_events = require("node:events");
let node_crypto = require("node:crypto");
let nodemailer = require("nodemailer");
nodemailer = __toESM(nodemailer);
let node_net = require("node:net");
let imapflow = require("imapflow");
let node_stream = require("node:stream");
let node_stream_promises = require("node:stream/promises");
// src/main/schema.ts
var SCHEMA;
var init_schema = __esmMin((() => {
	SCHEMA = `
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
  reply_status TEXT NOT NULL DEFAULT 'pending',
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
`;
}));
// src/main/sqlite.ts
/**
* SQLite 适配层：优先用 better-sqlite3（开发/测试，同步 API 快），
* 打包后没有原生模块时自动回退到 Electron 内置的 node:sqlite（Node 22+ / Electron 33+）。
*
* 这样 Windows 安装包不需要按平台重编译原生模块，macOS 上也能交叉打 exe。
* 暴露的 API 是 repos.ts 用到的子集：exec / prepare(run|get|all) / transaction / close。
*/
function toNumber(v) {
	return typeof v === "bigint" ? Number(v) : v;
}
/** better-sqlite3 实现（存在就用它，行为最稳） */
function openBetterSqlite(path) {
	if (process.env.MH_FORCE_NODE_SQLITE === "1") return null;
	try {
		const raw = new (requireCjs("better-sqlite3"))(path);
		return {
			driver: "better-sqlite3",
			exec: (sql) => raw.exec(sql),
			prepare: (sql) => {
				const stmt = raw.prepare(sql);
				return {
					run: (...params) => {
						const r = stmt.run(...params);
						return {
							changes: toNumber(r.changes),
							lastInsertRowid: toNumber(r.lastInsertRowid)
						};
					},
					get: (...params) => stmt.get(...params),
					all: (...params) => stmt.all(...params)
				};
			},
			transaction: (fn) => raw.transaction(fn),
			close: () => raw.close()
		};
	} catch {
		return null;
	}
}
/** node:sqlite 实现（Electron 内置，无需原生模块） */
function openNodeSqlite(path) {
	const { DatabaseSync } = requireCjs("node:sqlite");
	const raw = new DatabaseSync(path);
	let depth = 0;
	const exec = (sql) => raw.exec(sql);
	return {
		driver: "node:sqlite",
		exec,
		prepare: (sql) => {
			const stmt = raw.prepare(sql);
			return {
				run: (...params) => {
					const r = stmt.run(...params);
					return {
						changes: toNumber(r.changes),
						lastInsertRowid: toNumber(r.lastInsertRowid)
					};
				},
				get: (...params) => stmt.get(...params),
				all: (...params) => stmt.all(...params)
			};
		},
		transaction(fn) {
			return () => {
				depth++;
				const sp = depth;
				const nested = sp > 1;
				exec(nested ? `SAVEPOINT sp_${sp}` : "BEGIN");
				try {
					const result = fn();
					exec(nested ? `RELEASE sp_${sp}` : "COMMIT");
					return result;
				} catch (e) {
					try {
						if (nested) {
							exec(`ROLLBACK TO sp_${sp}`);
							exec(`RELEASE sp_${sp}`);
						} else exec("ROLLBACK");
					} catch {}
					throw e;
				} finally {
					depth--;
				}
			};
		},
		close: () => raw.close()
	};
}
function openSqlite(path) {
	const better = openBetterSqlite(path);
	if (better) {
		activeDriver = better.driver;
		return better;
	}
	const node = openNodeSqlite(path);
	activeDriver = node.driver;
	return node;
}
var requireCjs, activeDriver;
var init_sqlite = __esmMin((() => {
	requireCjs = (0, node_module.createRequire)(require("url").pathToFileURL(__filename).href);
}));
// src/main/db.ts
/**
* SQLite 数据层（WAL）。
* 驱动由 sqlite.ts 适配：开发用 better-sqlite3，打包后回退 Electron 内置 node:sqlite，
* 因此 Windows 安装包不需要按平台重编译原生模块。
* 表结构与 docs/ARCHITECTURE.md §4 对齐；密码字段用 Electron safeStorage 加密后存 BLOB。
*/
function getDbPath() {
	const userData = electron.app.getPath("userData");
	return (0, node_path.join)(userData, "mailharbor.db");
}
function openDb(customPath) {
	if (db$1) return db$1;
	const path = customPath ?? getDbPath();
	(0, node_fs.mkdirSync)((0, node_path.dirname)(path), { recursive: true });
	db$1 = openSqlite(path);
	db$1.exec(SCHEMA);
	db$1.prepare(`INSERT OR REPLACE INTO schema_meta(key,value) VALUES('version','1')`).run();
	return db$1;
}
function closeDb() {
	db$1?.close();
	db$1 = null;
}
/** 已打开的数据库实例（ipc.ts 直接用）；未打开时抛错，避免静默写入错误路径 */
function getDb() {
	if (!db$1) throw new Error("数据库尚未初始化（应先调用 openDb）");
	return db$1;
}
function encryptSecret(plain) {
	if (!plain) return Buffer.alloc(0);
	if (electron.safeStorage.isEncryptionAvailable()) return electron.safeStorage.encryptString(plain);
	console.warn("[security] safeStorage 不可用，密码将以明文形式存储");
	return Buffer.from(`plain:${plain}`, "utf8");
}
function decryptSecret(buf) {
	if (!buf || buf.length === 0) return "";
	try {
		const asText = buf.toString("utf8");
		if (asText.startsWith("plain:")) return asText.slice(6);
		if (!electron.safeStorage.isEncryptionAvailable()) return "";
		return electron.safeStorage.decryptString(buf);
	} catch {
		return "";
	}
}
function getSetting(key) {
	const row = openDb().prepare("SELECT value FROM settings WHERE key=?").get(key);
	if (!row) return DEFAULT_SETTINGS[key];
	try {
		return JSON.parse(row.value);
	} catch {
		return DEFAULT_SETTINGS[key];
	}
}
function setSetting(key, value) {
	openDb().prepare("INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").run(key, JSON.stringify(value), Date.now());
}
var db$1, DEFAULT_SETTINGS;
var init_db = __esmMin((() => {
	init_schema();
	init_sqlite();
	db$1 = null;
	DEFAULT_SETTINGS = {
		pollIntervalSec: 30,
		autostart: false,
		minimizeToTray: true,
		defaultPathEnabled: false,
		defaultPath: "",
		replyEnabled: true,
		replyDelaySec: 10,
		replyThreadOnce: true,
		replyHourlyCap: 60,
		replyLanguage: "en",
		factoryName: "海印 POD · 印前组",
		replySubjectZh: "图稿已收到 · {关键词}",
		replyBodyZh: "您好，\n\n已收到您的图稿（{数量} 个文件）：\n{文件名}\n\n我们会尽快安排处理，如需补充请直接回复本邮件。\n\n{工厂名}",
		replySubjectEn: "Artwork received — {关键词}",
		replyBodyEn: "Hi there,\n\nReceived — thanks! We've filed your artwork: {文件名}\n\nBest regards,\n{工厂名}",
		logLevel: "info",
		retryMaxAttempts: 8,
		multiRuleStrategy: "all"
	};
}));
// src/shared/ipc.ts
init_db();
var IPC = {
	accountList: "account:list",
	accountCreate: "account:create",
	accountUpdate: "account:update",
	accountDelete: "account:delete",
	accountTest: "account:test",
	accountTestSaved: "account:test-saved",
	accountToggle: "account:toggle",
	ruleList: "rule:list",
	ruleCreate: "rule:create",
	ruleUpdate: "rule:update",
	ruleDelete: "rule:delete",
	ruleToggle: "rule:toggle",
	ruleReorder: "rule:reorder",
	ruleTargetsHealth: "rule:targets-health",
	recordsList: "records:list",
	recordsRetry: "records:retry",
	recordsOpenFolder: "records:open-folder",
	recordsExport: "records:export",
	recordsClear: "records:clear",
	replyTest: "reply:test",
	dashboard: "dashboard:get",
	listeningSet: "listening:set",
	checkNow: "ops:check-now",
	settingsGet: "settings:get",
	settingsSave: "settings:save",
	pickFolder: "dialog:pick-folder",
	openPath: "shell:open-path",
	appInfo: "app:info",
	event: "main:event"
};
// src/main/repos.ts
/** backend 启动时注入数据库与密码编解码器（electron safeStorage 实现在 db.ts） */
function configureRepos(opts) {
	dbRef = opts.db;
	if (opts.codec) codec = opts.codec;
}
function db() {
	if (!dbRef) throw new Error("数据层未初始化：请先 configureRepos({ db })");
	return dbRef;
}
/** 本地时区今天 00:00 的毫秒时间戳 */
function startOfToday(at = now()) {
	const d = new Date(at);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}
function safeJsonArray(s, fallback = []) {
	if (!s) return fallback;
	try {
		const v = JSON.parse(s);
		return Array.isArray(v) ? v.map(String) : fallback;
	} catch {
		return fallback;
	}
}
function mapAccount(r, todayCount = 0, totalFiles = 0) {
	return {
		id: r.id,
		preset: r.preset,
		email: r.email,
		displayName: r.display_name ?? "",
		status: r.status,
		enabled: bool(r.enabled),
		imapHost: r.imap_host,
		imapPort: r.imap_port,
		imapSecure: r.imap_secure,
		imapUser: r.imap_user,
		smtpHost: r.smtp_host,
		smtpPort: r.smtp_port,
		smtpSecure: r.smtp_secure,
		smtpUser: r.smtp_user,
		smtpFromName: r.smtp_from_name ?? "",
		smtpSameAsImap: bool(r.smtp_same_as_imap),
		hasPassword: !!r.imap_pass_enc && r.imap_pass_enc.length > 0,
		lastCheckAt: r.last_check_at,
		lastOkAt: r.last_ok_at,
		lastErrorCode: r.last_error_code,
		lastError: r.last_error,
		lastUid: r.last_uid,
		uidValidity: r.uid_validity,
		todayCount,
		totalFiles,
		createdAt: r.created_at,
		updatedAt: r.updated_at
	};
}
function mapDelivery(r) {
	return {
		id: r.id,
		messageId: r.message_id,
		attachmentId: r.attachment_id,
		targetId: r.target_id,
		targetPath: r.target_path,
		required: bool(r.required),
		state: r.state,
		attempts: r.attempts,
		nextRetryAt: r.next_retry_at,
		savedPath: r.saved_path,
		savedName: r.saved_name,
		size: r.size,
		errorCode: r.error_code,
		error: r.error,
		finishedAt: r.finished_at
	};
}
function healthKey(path) {
	return (0, node_path.resolve)(path);
}
/** 同步检查一个目录：存在、是目录、可写、剩余空间 */
function checkDiskHealth(path) {
	try {
		if (!path) return {
			health: "unknown",
			freeBytes: null,
			totalBytes: null
		};
		if (!(0, node_fs.statSync)(path).isDirectory()) return {
			health: "unavailable",
			freeBytes: null,
			totalBytes: null
		};
		(0, node_fs.accessSync)(path, node_fs.constants.W_OK);
		const fsStat = (0, node_fs.statfsSync)(path);
		const free = Number(fsStat.bavail) * Number(fsStat.bsize);
		const total = Number(fsStat.blocks) * Number(fsStat.bsize);
		return {
			health: free < 2147483648 ? "low_space" : "ok",
			freeBytes: free,
			totalBytes: total
		};
	} catch {
		return {
			health: "unavailable",
			freeBytes: null,
			totalBytes: null
		};
	}
}
function healthOf(path, allowCheck = true) {
	const key = healthKey(path);
	const hit = healthCache.get(key);
	if (hit && now() - hit.checkedAt < HEALTH_TTL_MS) return {
		health: hit.health,
		freeBytes: hit.freeBytes,
		totalBytes: hit.totalBytes,
		lastHealth: hit.health
	};
	if (!allowCheck) return {
		health: "unknown",
		freeBytes: null,
		totalBytes: null,
		lastHealth: hit?.health ?? null
	};
	const info = checkDiskHealth(path);
	healthCache.set(key, {
		...info,
		checkedAt: now()
	});
	return {
		...info,
		lastHealth: info.health
	};
}
/** 刷新所有启用规则的目标路径健康（规则页 / 概览角标用） */
function refreshTargetsHealth() {
	const rows = db().prepare(`SELECT t.path FROM rule_targets t JOIN rules r ON r.id=t.rule_id
       WHERE t.deleted_at IS NULL AND t.enabled=1 AND r.deleted_at IS NULL AND r.enabled=1`).all();
	const at = now();
	for (const r of rows) {
		const info = checkDiskHealth(r.path);
		healthCache.set(healthKey(r.path), {
			...info,
			checkedAt: at
		});
	}
}
function listAccounts() {
	const rows = db().prepare("SELECT * FROM accounts ORDER BY id ASC").all();
	const today = startOfToday();
	const todayRows = db().prepare("SELECT account_id, COUNT(*) AS c FROM messages WHERE received_at >= ? GROUP BY account_id").all(today);
	const fileRows = db().prepare(`SELECT m.account_id AS account_id, COUNT(DISTINCT d.attachment_id) AS c
       FROM deliveries d JOIN messages m ON m.id=d.message_id
       WHERE d.state='done' GROUP BY m.account_id`).all();
	const tMap = new Map(todayRows.map((r) => [r.account_id, r.c]));
	const fMap = new Map(fileRows.map((r) => [r.account_id, r.c]));
	return rows.map((r) => mapAccount(r, tMap.get(r.id) ?? 0, fMap.get(r.id) ?? 0));
}
function getAccount(id) {
	const row = db().prepare("SELECT * FROM accounts WHERE id=?").get(id);
	if (!row) return null;
	return mapAccount(row, accountTodayCount(id), accountTotalFiles(id));
}
function getAccountRow(id) {
	return db().prepare("SELECT * FROM accounts WHERE id=?").get(id) ?? null;
}
/** 读取解密后的密码（只在内核服务里用，绝不进日志 / 事件） */
function getAccountSecrets(id) {
	const row = getAccountRow(id);
	if (!row) return {
		imapPass: "",
		smtpPass: ""
	};
	const imapPass = codec.decrypt(row.imap_pass_enc);
	return {
		imapPass,
		smtpPass: row.smtp_same_as_imap ? imapPass : codec.decrypt(row.smtp_pass_enc)
	};
}
function createAccount(input) {
	const email = (input.email ?? "").trim();
	const imapUser = (input.imapUser ?? "").trim();
	if (!email) throw new Error("请填写邮箱地址");
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("邮箱地址格式不正确");
	if (!input.imapHost?.trim()) throw new Error("请填写 IMAP 服务器地址");
	if (!imapUser) throw new Error("请填写 IMAP 用户名");
	if (!input.smtpHost?.trim()) throw new Error("请填写 SMTP 服务器地址");
	if (!input.password) throw new Error("请填写应用专用密码 / 授权码");
	const smtpPass = input.smtpSameAsImap ? input.password : input.smtpPassword ?? "";
	if (!input.smtpSameAsImap && !smtpPass) throw new Error("请填写 SMTP 密码");
	const ts = now();
	try {
		const info = db().prepare(`INSERT INTO accounts(
           preset,email,display_name,enabled,status,
           imap_host,imap_port,imap_secure,imap_user,imap_pass_enc,
           smtp_host,smtp_port,smtp_secure,smtp_user,smtp_from_name,smtp_same_as_imap,smtp_pass_enc,
           uid_validity,last_uid,created_at,updated_at
         ) VALUES(?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?,?,?, NULL,0,?,?)`).run(input.preset, email, input.displayName?.trim() || email.split("@")[0], 1, "pending_test", input.imapHost.trim(), Number(input.imapPort) || 993, input.imapSecure, imapUser, codec.encrypt(input.password), input.smtpHost.trim(), Number(input.smtpPort) || 465, input.smtpSecure, input.smtpUser?.trim() || imapUser, input.smtpFromName?.trim() || "MailHarbor 收货助手", bit(input.smtpSameAsImap), codec.encrypt(smtpPass), ts, ts);
		return getAccount(Number(info.lastInsertRowid));
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (msg.includes("UNIQUE")) throw new Error("该邮箱服务器 + 账号已存在，请勿重复添加");
		throw new Error(`保存账户失败：${msg}`);
	}
}
function updateAccount(id, input) {
	const old = getAccountRow(id);
	if (!old) throw new Error("账户不存在或已被删除");
	const email = (input.email ?? "").trim();
	if (!email) throw new Error("请填写邮箱地址");
	const imapUser = (input.imapUser ?? "").trim();
	if (!input.imapHost?.trim()) throw new Error("请填写 IMAP 服务器地址");
	if (!input.smtpHost?.trim()) throw new Error("请填写 SMTP 服务器地址");
	const toBuffer = (b) => b ? Buffer.from(b) : null;
	const newImapPass = input.password ? codec.encrypt(input.password) : toBuffer(old.imap_pass_enc);
	const smtpSame = !!input.smtpSameAsImap;
	let newSmtpPass;
	if (smtpSame) newSmtpPass = input.password ? codec.encrypt(input.password) : toBuffer(old.smtp_pass_enc);
	else if (input.smtpPassword) newSmtpPass = codec.encrypt(input.smtpPassword);
	else newSmtpPass = toBuffer(old.smtp_pass_enc);
	const changedConfig = "password" in input && !!input.password ? true : old.imap_host !== input.imapHost.trim() || old.imap_port !== (Number(input.imapPort) || 993) || old.imap_secure !== input.imapSecure || old.imap_user !== imapUser || old.smtp_host !== input.smtpHost.trim() || old.smtp_port !== (Number(input.smtpPort) || 465) || old.smtp_secure !== input.smtpSecure || old.smtp_user !== (input.smtpUser?.trim() || imapUser) || old.email !== email || old.smtp_same_as_imap !== bit(smtpSame);
	const nextStatus = !old.enabled ? "disabled" : changedConfig ? "pending_test" : old.status;
	try {
		db().prepare(`UPDATE accounts SET
           preset=?, email=?, display_name=?, status=?,
           imap_host=?, imap_port=?, imap_secure=?, imap_user=?, imap_pass_enc=?,
           smtp_host=?, smtp_port=?, smtp_secure=?, smtp_user=?, smtp_from_name=?, smtp_same_as_imap=?, smtp_pass_enc=?,
           last_error_code=?, last_error=?, updated_at=?
         WHERE id=?`).run(input.preset, email, input.displayName?.trim() || email.split("@")[0], nextStatus, input.imapHost.trim(), Number(input.imapPort) || 993, input.imapSecure, imapUser, newImapPass, input.smtpHost.trim(), Number(input.smtpPort) || 465, input.smtpSecure, input.smtpUser?.trim() || imapUser, input.smtpFromName?.trim() || "MailHarbor 收货助手", bit(smtpSame), newSmtpPass, changedConfig ? null : old.last_error_code, changedConfig ? null : old.last_error, now(), id);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (msg.includes("UNIQUE")) throw new Error("该邮箱服务器 + 账号已存在，请勿重复添加");
		throw new Error(`保存账户失败：${msg}`);
	}
	return getAccount(id);
}
function deleteAccount(id) {
	db().prepare("DELETE FROM accounts WHERE id=?").run(id);
}
function setAccountEnabled(id, enabled) {
	const row = getAccountRow(id);
	if (!row) throw new Error("账户不存在或已被删除");
	const status = enabled ? row.status === "disabled" ? "pending_test" : row.status : "disabled";
	db().prepare("UPDATE accounts SET enabled=?, status=?, updated_at=? WHERE id=?").run(bit(enabled), status, now(), id);
	return getAccount(id);
}
function setAccountStatus(id, status, opts = {}) {
	const ts = now();
	db().prepare(`UPDATE accounts SET status=?, last_error_code=?, last_error=?,
         last_check_at=CASE WHEN ? THEN ? ELSE last_check_at END,
         last_ok_at=CASE WHEN ? THEN ? ELSE last_ok_at END
       WHERE id=?`).run(status, opts.errorCode ?? null, opts.error ?? null, opts.checked ? 1 : 0, ts, opts.ok ? 1 : 0, ts, id);
}
/** 增量收信游标 / 健康时间 */
function updateAccountSyncState(id, state) {
	const row = getAccountRow(id);
	if (!row) return;
	db().prepare(`UPDATE accounts SET last_uid=?, uid_validity=?, last_check_at=?, last_ok_at=? WHERE id=?`).run(state.lastUid ?? row.last_uid, state.uidValidity === void 0 ? row.uid_validity : state.uidValidity, state.lastCheckAt ?? row.last_check_at, state.lastOkAt ?? row.last_ok_at, id);
}
function accountTodayCount(accountId) {
	return db().prepare("SELECT COUNT(*) AS c FROM messages WHERE account_id=? AND received_at >= ?").get(accountId, startOfToday()).c;
}
function accountTotalFiles(accountId) {
	return db().prepare(`SELECT COUNT(DISTINCT d.attachment_id) AS c FROM deliveries d
       JOIN messages m ON m.id=d.message_id WHERE m.account_id=? AND d.state='done'`).get(accountId).c;
}
function targetsOfRule(ruleId, includeDeleted = false) {
	const sql = includeDeleted ? "SELECT * FROM rule_targets WHERE rule_id=? ORDER BY sort_order ASC, id ASC" : "SELECT * FROM rule_targets WHERE rule_id=? AND deleted_at IS NULL AND enabled=1 ORDER BY sort_order ASC, id ASC";
	return db().prepare(sql).all(ruleId);
}
function mapRuleTarget(t) {
	const h = healthOf(t.path);
	return {
		id: t.id,
		ruleId: t.rule_id,
		path: t.path,
		required: bool(t.required),
		sortOrder: t.sort_order,
		enabled: bool(t.enabled),
		lastHealth: h.lastHealth,
		freeBytes: h.freeBytes,
		totalBytes: h.totalBytes
	};
}
function mapRule(r) {
	return {
		id: r.id,
		keyword: r.keyword,
		enabled: bool(r.enabled),
		scope: r.scope,
		mode: r.mode,
		priority: r.priority,
		fileTypes: safeJsonArray(r.file_types, [
			"zip",
			"tif",
			"tiff"
		]),
		autoReply: bool(r.auto_reply),
		hitMessages: r.hit_messages,
		hitFiles: r.hit_files,
		lastHitAt: r.last_hit_at,
		targets: targetsOfRule(r.id).map(mapRuleTarget),
		createdAt: r.created_at,
		updatedAt: r.updated_at
	};
}
/** 规则列表（仅未删除）；健康值优先用缓存，过期则现场检查一次 */
function listRules() {
	return db().prepare("SELECT * FROM rules WHERE deleted_at IS NULL ORDER BY priority ASC, id ASC").all().map(mapRule);
}
/** 规则页专用：先刷新磁盘健康再返回（targetsHealth 接口） */
function listRulesWithHealth() {
	refreshTargetsHealth();
	return listRules();
}
function getRule(id) {
	const row = db().prepare("SELECT * FROM rules WHERE id=? AND deleted_at IS NULL").get(id);
	return row ? mapRule(row) : null;
}
function normalizeTargetPaths(targets) {
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const t of targets ?? []) {
		const raw = (t.path ?? "").trim();
		if (!raw) continue;
		const key = (0, node_path.resolve)(raw).toLowerCase();
		if (seen.has(key)) throw new Error("同一规则下的目标文件夹不能重复");
		seen.add(key);
		out.push({
			id: t.id,
			path: raw,
			required: t.required !== false
		});
	}
	if (out.length === 0) throw new Error("请至少配置一个目标文件夹");
	return out;
}
function validateRuleInput(input) {
	if (!input.keyword?.trim()) throw new Error("关键词不能为空");
	if (!Array.isArray(input.fileTypes) || input.fileTypes.length === 0) throw new Error("请至少选择一种附件类型");
	normalizeTargetPaths(input.targets);
}
function createRule(input) {
	validateRuleInput(input);
	const targets = normalizeTargetPaths(input.targets);
	const ts = now();
	const d = db();
	return getRule(d.transaction(() => {
		const info = d.prepare(`INSERT INTO rules(keyword,enabled,scope,mode,priority,file_types,auto_reply,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?)`).run(input.keyword.trim(), bit(input.enabled), input.scope, input.mode, Number(input.priority) || 100, JSON.stringify(input.fileTypes.map((t) => t.toLowerCase().replace(/^\./, ""))), bit(input.autoReply), ts, ts);
		const ruleId = Number(info.lastInsertRowid);
		const ins = d.prepare(`INSERT INTO rule_targets(rule_id,path,required,sort_order,enabled,created_at) VALUES(?,?,?,?,1,?)`);
		targets.forEach((t, i) => ins.run(ruleId, t.path, bit(t.required), i, ts));
		return ruleId;
	})());
}
function updateRule(id, input) {
	validateRuleInput(input);
	const targets = normalizeTargetPaths(input.targets);
	const old = db().prepare("SELECT * FROM rules WHERE id=? AND deleted_at IS NULL").get(id);
	if (!old) throw new Error("规则不存在或已被删除");
	const ts = now();
	const d = db();
	d.transaction(() => {
		d.prepare(`UPDATE rules SET keyword=?,enabled=?,scope=?,mode=?,priority=?,file_types=?,auto_reply=?,updated_at=? WHERE id=?`).run(input.keyword.trim(), bit(input.enabled), input.scope, input.mode, Number(input.priority) || old.priority, JSON.stringify(input.fileTypes.map((t) => t.toLowerCase().replace(/^\./, ""))), bit(input.autoReply), ts, id);
		const existing = targetsOfRule(id, true);
		const byId = new Map(existing.map((t) => [t.id, t]));
		const used = /* @__PURE__ */ new Set();
		const ins = d.prepare(`INSERT INTO rule_targets(rule_id,path,required,sort_order,enabled,deleted_at,created_at) VALUES(?,?,?,?,1,NULL,?)`);
		const upd = d.prepare(`UPDATE rule_targets SET path=?,required=?,sort_order=?,enabled=1,deleted_at=NULL WHERE id=?`);
		targets.forEach((t, i) => {
			let hit;
			if (t.id && byId.has(t.id) && !used.has(t.id)) hit = byId.get(t.id);
			if (!hit) hit = existing.find((e) => !used.has(e.id) && (0, node_path.resolve)(e.path).toLowerCase() === (0, node_path.resolve)(t.path).toLowerCase());
			if (hit) {
				used.add(hit.id);
				upd.run(t.path, bit(t.required), i, hit.id);
			} else ins.run(id, t.path, bit(t.required), i, ts);
		});
		const del = d.prepare("DELETE FROM rule_targets WHERE id=?");
		for (const e of existing) if (!used.has(e.id)) del.run(e.id);
	})();
	return getRule(id);
}
/** 软删除：deleted_at 置位后不再参与匹配，历史记录仍可引用 keyword 快照 */
function deleteRule(id) {
	const ts = now();
	const d = db();
	d.transaction(() => {
		d.prepare("UPDATE rules SET deleted_at=?, enabled=0, updated_at=? WHERE id=?").run(ts, ts, id);
		d.prepare("UPDATE rule_targets SET deleted_at=?, enabled=0 WHERE rule_id=?").run(ts, id);
	})();
}
function setRuleEnabled(id, enabled) {
	db().prepare("UPDATE rules SET enabled=?, updated_at=? WHERE id=? AND deleted_at IS NULL").run(bit(enabled), now(), id);
	const rule = getRule(id);
	if (!rule) throw new Error("规则不存在或已被删除");
	return rule;
}
/** 拖拽排序：按数组顺序重写 priority（数字越小越优先） */
function reorderRules(ids) {
	const d = db();
	const upd = d.prepare("UPDATE rules SET priority=?, updated_at=? WHERE id=? AND deleted_at IS NULL");
	const ts = now();
	d.transaction(() => {
		ids.forEach((id, i) => upd.run((i + 1) * 10, ts, id));
	})();
}
/** 命中计数：邮件数 +1、文件数 +N、最近命中时间 */
function hitIncrement(ruleId, opts = {}) {
	db().prepare(`UPDATE rules SET hit_messages=hit_messages+?, hit_files=hit_files+?, last_hit_at=?, updated_at=? WHERE id=?`).run(opts.messages ?? 1, opts.files ?? 0, now(), now(), ruleId);
}
/** 幂等 upsert：唯一键 (account_id,imap_uid)。返回 id 与是否新插入 */
function upsertMessage(input) {
	const d = db();
	const ts = now();
	const existing = d.prepare("SELECT id FROM messages WHERE account_id=? AND imap_uid=?").get(input.accountId, input.imapUid);
	if (existing) {
		d.prepare(`UPDATE messages SET
         provider_message_id=COALESCE(?, provider_message_id),
         thread_key=COALESCE(?, thread_key),
         rfc_message_id=COALESCE(?, rfc_message_id),
         subject=COALESCE(?, subject),
         from_addr=COALESCE(?, from_addr),
         from_name=COALESCE(?, from_name),
         received_at=COALESCE(?, received_at),
         updated_at=?
       WHERE id=?`).run(input.providerMessageId ?? null, input.threadKey ?? null, input.rfcMessageId ?? null, input.subject ?? null, input.fromAddr ?? null, input.fromName ?? null, input.receivedAt ?? null, ts, existing.id);
		return {
			id: existing.id,
			inserted: false
		};
	}
	const info = d.prepare(`INSERT INTO messages(
         account_id,imap_uid,provider_message_id,thread_key,rfc_message_id,subject,from_addr,from_name,
         received_at,matched_rule_id,matched_keyword,match_source,status,reply_status,error,created_at,updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.accountId, input.imapUid, input.providerMessageId ?? null, input.threadKey ?? null, input.rfcMessageId ?? null, input.subject ?? null, input.fromAddr ?? null, input.fromName ?? null, input.receivedAt ?? null, input.matchedRuleId ?? null, input.matchedKeyword ?? null, input.matchSource ?? null, input.status ?? "queued", input.replyStatus ?? "pending", input.error ?? null, ts, ts);
	return {
		id: Number(info.lastInsertRowid),
		inserted: true
	};
}
function getMessage(id) {
	return db().prepare("SELECT * FROM messages WHERE id=?").get(id) ?? null;
}
function getMessageByUid(accountId, imapUid) {
	return db().prepare("SELECT * FROM messages WHERE account_id=? AND imap_uid=?").get(accountId, imapUid) ?? null;
}
function updateMessageStatus(id, status, error) {
	db().prepare("UPDATE messages SET status=?, error=?, updated_at=? WHERE id=?").run(status, error ?? null, now(), id);
}
function updateMessageReplyStatus(id, status, error) {
	db().prepare("UPDATE messages SET reply_status=?, error=COALESCE(?, error), updated_at=? WHERE id=?").run(status, error ?? null, now(), id);
}
function updateMessageMatch(id, patch) {
	const row = getMessage(id);
	if (!row) return;
	db().prepare("UPDATE messages SET matched_rule_id=?, matched_keyword=?, match_source=?, updated_at=? WHERE id=?").run(patch.matchedRuleId === void 0 ? row.matched_rule_id : patch.matchedRuleId, patch.matchedKeyword === void 0 ? row.matched_keyword : patch.matchedKeyword, patch.matchSource === void 0 ? row.match_source : patch.matchSource, now(), id);
}
function upsertAttachment(messageId, input) {
	const d = db();
	const ts = now();
	const existing = d.prepare("SELECT * FROM attachments WHERE message_id=? AND part_id=?").get(messageId, input.partId);
	if (existing) {
		d.prepare("UPDATE attachments SET filename=?, mime_type=?, declared_size=?, updated_at=? WHERE id=?").run(input.filename, input.mimeType ?? null, input.declaredSize ?? null, ts, existing.id);
		return d.prepare("SELECT * FROM attachments WHERE id=?").get(existing.id);
	}
	const info = d.prepare(`INSERT INTO attachments(message_id,part_id,filename,mime_type,declared_size,status,created_at,updated_at)
       VALUES(?,?,?,?,?,'pending',?,?)`).run(messageId, input.partId, input.filename, input.mimeType ?? null, input.declaredSize ?? null, ts, ts);
	return d.prepare("SELECT * FROM attachments WHERE id=?").get(Number(info.lastInsertRowid));
}
function getAttachment(id) {
	return db().prepare("SELECT * FROM attachments WHERE id=?").get(id) ?? null;
}
function listAttachmentsByMessage(messageId) {
	return db().prepare("SELECT * FROM attachments WHERE message_id=? ORDER BY id ASC").all(messageId);
}
function setAttachmentDownloaded(id, info) {
	db().prepare(`UPDATE attachments SET tmp_path=?, size=?, sha256=?, status='downloaded', error=NULL, updated_at=? WHERE id=?`).run(info.tmpPath, info.size, info.sha256, now(), id);
}
function setAttachmentStatus(id, status, error) {
	db().prepare("UPDATE attachments SET status=?, error=?, updated_at=? WHERE id=?").run(status, error ?? null, now(), id);
}
/** 幂等创建（INSERT OR IGNORE, 唯一键 attachment_id+target_id），返回该消息全部 delivery */
function createDeliveries(items) {
	if (items.length === 0) return [];
	const d = db();
	const ts = now();
	const ins = d.prepare(`INSERT OR IGNORE INTO deliveries(
       message_id,attachment_id,target_id,target_path,required,state,attempts,created_at,updated_at
     ) VALUES(?,?,?,?,?,'pending',0,?,?)`);
	d.transaction(() => {
		for (const it of items) ins.run(it.messageId, it.attachmentId, it.targetId, it.targetPath, bit(it.required), ts, ts);
	})();
	return listDeliveriesByMessage(items[0].messageId);
}
function listDeliveriesByMessage(messageId) {
	return db().prepare("SELECT * FROM deliveries WHERE message_id=? ORDER BY id ASC").all(messageId);
}
function getDelivery(id) {
	return db().prepare("SELECT * FROM deliveries WHERE id=?").get(id) ?? null;
}
/** 待处理队列：pending（无 next_retry_at 或已到期）+ retry_wait 到期 */
function dueDeliveries(at = now(), limit = 200) {
	return db().prepare(`SELECT * FROM deliveries
       WHERE (state='pending' AND (next_retry_at IS NULL OR next_retry_at<=?))
          OR (state='retry_wait' AND next_retry_at IS NOT NULL AND next_retry_at<=?)
       ORDER BY id ASC LIMIT ?`).all(at, at, limit);
}
function copyingDeliveries() {
	return db().prepare("SELECT * FROM deliveries WHERE state='copying'").all();
}
function updateDeliveryState(id, state, patch = {}) {
	const row = getDelivery(id);
	if (!row) return;
	db().prepare(`UPDATE deliveries SET state=?, attempts=?, next_retry_at=?, saved_path=?, saved_name=?, size=?, sha256=?,
         error_code=?, error=?, started_at=?, finished_at=?, updated_at=? WHERE id=?`).run(state, patch.attempts ?? row.attempts, patch.nextRetryAt === void 0 ? row.next_retry_at : patch.nextRetryAt, patch.savedPath === void 0 ? row.saved_path : patch.savedPath, patch.savedName === void 0 ? row.saved_name : patch.savedName, patch.size === void 0 ? row.size : patch.size, patch.sha256 === void 0 ? row.sha256 : patch.sha256, patch.errorCode === void 0 ? row.error_code : patch.errorCode, patch.error === void 0 ? row.error : patch.error, patch.startedAt === void 0 ? row.started_at : patch.startedAt, patch.finishedAt === void 0 ? row.finished_at : patch.finishedAt, now(), id);
}
function markDeliveryDone(id, info) {
	const ts = now();
	db().prepare(`UPDATE deliveries SET state='done', saved_path=?, saved_name=?, size=?, sha256=?, error_code=NULL, error=NULL,
         next_retry_at=NULL, finished_at=?, updated_at=? WHERE id=?`).run(info.savedPath, info.savedName, info.size, info.sha256 ?? null, ts, ts, id);
}
/** 失败重试：attempts 由调用方决定（路径不可用不消耗 attempts） */
function markDeliveryRetry(id, opts) {
	db().prepare(`UPDATE deliveries SET state='retry_wait', attempts=?, next_retry_at=?, error_code=?, error=?, updated_at=? WHERE id=?`).run(opts.attempts, opts.nextRetryAt, opts.errorCode, opts.error, now(), id);
}
function markDeliveryFailed(id, opts) {
	const ts = now();
	db().prepare(`UPDATE deliveries SET state='failed', attempts=?, next_retry_at=NULL, error_code=?, error=?, finished_at=?, updated_at=? WHERE id=?`).run(opts.attempts, opts.errorCode, opts.error, ts, ts, id);
}
/** 手动重试：deliveryId 省略时重置该邮件全部 failed 记录；返回受影响条数 */
function resetDeliveriesForRetry(messageId, deliveryId) {
	const d = db();
	const ts = now();
	return (deliveryId ? d.prepare(`UPDATE deliveries SET state='pending', attempts=0, next_retry_at=NULL, error_code=NULL, error=NULL,
             finished_at=NULL, updated_at=? WHERE id=? AND message_id=?`).run(ts, deliveryId, messageId) : d.prepare(`UPDATE deliveries SET state='pending', attempts=0, next_retry_at=NULL, error_code=NULL, error=NULL,
             finished_at=NULL, updated_at=? WHERE message_id=? AND state='failed'`).run(ts, messageId)).changes;
}
/** 启动对账：把 copying 改回 pending（dispatcher 会先尝试认领已落盘文件） */
function resetCopyingDeliveries() {
	return db().prepare("UPDATE deliveries SET state='pending', updated_at=? WHERE state='copying'").run(now()).changes;
}
function deliveryAggregate(messageId) {
	const rows = listDeliveriesByMessage(messageId);
	const agg = {
		total: rows.length,
		done: 0,
		failed: 0,
		skipped: 0,
		pending: 0,
		retryWait: 0,
		copying: 0,
		requiredTotal: 0,
		requiredDone: 0,
		requiredFailed: 0,
		allTerminal: true,
		requiredAllDone: true
	};
	for (const r of rows) {
		if (r.required) {
			agg.requiredTotal++;
			if (r.state === "done") agg.requiredDone++;
			if (r.state === "failed") agg.requiredFailed++;
			if (r.state !== "done") agg.requiredAllDone = false;
		}
		switch (r.state) {
			case "done":
				agg.done++;
				break;
			case "failed":
				agg.failed++;
				break;
			case "skipped":
				agg.skipped++;
				break;
			case "pending":
				agg.pending++;
				agg.allTerminal = false;
				break;
			case "copying":
				agg.copying++;
				agg.allTerminal = false;
				break;
			case "retry_wait":
				agg.retryWait++;
				agg.allTerminal = false;
		}
	}
	return agg;
}
function hasSentThread(accountId, threadKey) {
	return db().prepare("SELECT COUNT(*) AS c FROM auto_replies WHERE account_id=? AND thread_key=? AND status='sent'").get(accountId, threadKey).c > 0;
}
function insertReply(input) {
	const info = db().prepare(`INSERT INTO auto_replies(
         account_id,message_id,thread_key,to_addr,subject,body_preview,status,provider_message_id,error,sent_at,created_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(input.accountId, input.messageId, input.threadKey, input.toAddr, input.subject ?? null, input.bodyPreview ?? null, input.status, input.providerMessageId ?? null, input.error ?? null, input.sentAt ?? null, now());
	return Number(info.lastInsertRowid);
}
/** 今日已成功回信数（日上限 300 用） */
function repliesTodayCount(accountId) {
	return db().prepare("SELECT COUNT(*) AS c FROM auto_replies WHERE account_id=? AND status='sent' AND sent_at>=?").get(accountId, startOfToday()).c;
}
/** 最近一小时内已发出的回信数（每小时上限用） */
function repliesLastHourCount(accountId, nowMs = Date.now()) {
	return db().prepare("SELECT COUNT(*) AS c FROM auto_replies WHERE account_id=? AND status='sent' AND sent_at>=?").get(accountId, nowMs - 36e5).c;
}
function buildRecordQuery(q) {
	const where = [];
	const params = [];
	if (q.status && q.status !== "all") {
		if (q.status === "partial") where.push("m.status IN ('partial','failed')");
		else if (q.status === "done") where.push("m.status IN ('done')");
		else {
			where.push("m.status=?");
			params.push(q.status);
		}
	}
	if (q.accountId != null) {
		where.push("m.account_id=?");
		params.push(q.accountId);
	}
	if (q.keyword) {
		where.push("m.matched_keyword LIKE ?");
		params.push(`%${q.keyword}%`);
	}
	if (q.search) {
		where.push(`(m.subject LIKE ? OR m.from_addr LIKE ? OR m.from_name LIKE ? OR m.matched_keyword LIKE ?
        OR EXISTS (SELECT 1 FROM attachments a2 WHERE a2.message_id = m.id AND a2.filename LIKE ?))`);
		const s = `%${q.search}%`;
		params.push(s, s, s, s, s);
	}
	if (q.from != null) {
		where.push("m.received_at>=?");
		params.push(q.from);
	}
	if (q.to != null) {
		where.push("m.received_at<=?");
		params.push(q.to);
	}
	return {
		sql: where.length ? `WHERE ${where.join(" AND ")}` : "",
		params
	};
}
function toRecordRow(m, accountEmail, attachments, deliveries) {
	const byAttachment = /* @__PURE__ */ new Map();
	for (const d of deliveries) {
		const arr = byAttachment.get(d.attachment_id) ?? [];
		arr.push(d);
		byAttachment.set(d.attachment_id, arr);
	}
	return {
		id: m.id,
		accountId: m.account_id,
		accountEmail,
		subject: m.subject ?? "",
		fromAddr: m.from_addr ?? "",
		fromName: m.from_name ?? "",
		receivedAt: m.received_at ?? m.created_at,
		matchedKeyword: m.matched_keyword,
		matchedRuleId: m.matched_rule_id,
		status: m.status,
		replyStatus: m.reply_status,
		error: m.error,
		attachments: attachments.map((a) => ({
			id: a.id,
			filename: a.filename,
			size: a.size ?? a.declared_size ?? null,
			state: a.status,
			deliveries: (byAttachment.get(a.id) ?? []).map(mapDelivery)
		}))
	};
}
function listRecords(q = {}) {
	const d = db();
	const page = Math.max(1, Math.floor(Number(q.page) || 1));
	const pageSize = Math.min(1e5, Math.max(1, Math.floor(Number(q.pageSize) || 20)));
	const { sql: whereSql, params } = buildRecordQuery(q);
	const totalRow = d.prepare(`SELECT COUNT(*) AS c FROM messages m ${whereSql}`).get(...params);
	const rows = d.prepare(`SELECT m.*, COALESCE(a.email,'') AS account_email
       FROM messages m LEFT JOIN accounts a ON a.id=m.account_id
       ${whereSql}
       ORDER BY COALESCE(m.received_at, m.created_at) DESC, m.id DESC
       LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
	if (rows.length === 0) return {
		total: totalRow.c,
		page,
		pageSize,
		rows: []
	};
	const ids = rows.map((r) => r.id);
	const ph = ids.map(() => "?").join(",");
	const attachments = d.prepare(`SELECT * FROM attachments WHERE message_id IN (${ph}) ORDER BY id ASC`).all(...ids);
	const deliveries = d.prepare(`SELECT * FROM deliveries WHERE message_id IN (${ph}) ORDER BY id ASC`).all(...ids);
	const aMap = /* @__PURE__ */ new Map();
	for (const a of attachments) {
		const arr = aMap.get(a.message_id) ?? [];
		arr.push(a);
		aMap.set(a.message_id, arr);
	}
	const dMap = /* @__PURE__ */ new Map();
	for (const dl of deliveries) {
		const arr = dMap.get(dl.message_id) ?? [];
		arr.push(dl);
		dMap.set(dl.message_id, arr);
	}
	return {
		total: totalRow.c,
		page,
		pageSize,
		rows: rows.map((m) => toRecordRow(m, m.account_email, aMap.get(m.id) ?? [], dMap.get(m.id) ?? []))
	};
}
function getRecordById(messageId) {
	const row = db().prepare(`SELECT m.*, COALESCE(a.email,'') AS account_email
       FROM messages m LEFT JOIN accounts a ON a.id=m.account_id WHERE m.id=?`).get(messageId);
	if (!row) return null;
	return toRecordRow(row, row.account_email, listAttachmentsByMessage(messageId), listDeliveriesByMessage(messageId));
}
/** 打开记录对应文件夹：优先已落盘文件的所在目录，否则目标路径 */
function folderOfRecord(messageId, deliveryId) {
	const deliveries = listDeliveriesByMessage(messageId);
	const chosen = deliveryId ? deliveries.find((x) => x.id === deliveryId) : deliveries.find((x) => x.saved_path) ?? deliveries[0];
	if (!chosen) return null;
	if (chosen.saved_path) return (0, node_path.dirname)(chosen.saved_path);
	return chosen.target_path || null;
}
function csvCell(v) {
	const s = v === null || v === void 0 ? "" : String(v);
	return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, "\"\"")}"` : s;
}
function recordsToCsv(rows) {
	const lines = [[
		"时间",
		"账户",
		"发件人",
		"主题",
		"命中关键词",
		"附件",
		"目标路径结果",
		"状态",
		"回信状态",
		"错误"
	].map(csvCell).join(",")];
	const fmt = (t) => {
		const d = new Date(t);
		const p = (n) => String(n).padStart(2, "0");
		return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
	};
	for (const r of rows) {
		const attachments = r.attachments.map((a) => `${a.filename}${a.size ? `(${a.size}B)` : ""}`).join(" / ");
		const deliveries = r.attachments.flatMap((a) => a.deliveries).map((d) => `${d.targetPath}: ${DELIVERY_ZH[d.state]}${d.savedName ? `(${d.savedName})` : ""}${d.errorCode ? `[${d.errorCode}]` : ""}`).join(" / ");
		lines.push([
			fmt(r.receivedAt),
			r.accountEmail,
			`${r.fromName} <${r.fromAddr}>`,
			r.subject,
			r.matchedKeyword ?? "",
			attachments,
			deliveries,
			STATUS_ZH[r.status] ?? r.status,
			REPLY_ZH[r.replyStatus] ?? r.replyStatus,
			r.error ?? ""
		].map(csvCell).join(","));
	}
	return lines.join("\r\n");
}
function dashboardStats() {
	const d = db();
	const today = startOfToday();
	const one = (sql, ...args) => d.prepare(sql).get(...args).c;
	return {
		todayMessages: one("SELECT COUNT(*) AS c FROM messages WHERE received_at>=?", today),
		todayMatched: one("SELECT COUNT(*) AS c FROM messages WHERE received_at>=? AND matched_rule_id IS NOT NULL", today),
		todayFiles: one("SELECT COUNT(DISTINCT attachment_id) AS c FROM deliveries WHERE state='done' AND finished_at>=?", today),
		todayFailed: one("SELECT COUNT(*) AS c FROM messages WHERE received_at>=? AND status='failed'", today),
		pendingRetry: one("SELECT COUNT(*) AS c FROM deliveries WHERE state IN ('pending','retry_wait','copying')")
	};
}
/** 概览页「各目标盘剩余空间」：所有启用规则的目标路径去重，附所属关键词 */
function listDisks() {
	const rows = db().prepare(`SELECT t.path AS path, r.keyword AS keyword
       FROM rule_targets t JOIN rules r ON r.id=t.rule_id
       WHERE t.deleted_at IS NULL AND t.enabled=1 AND r.deleted_at IS NULL AND r.enabled=1
       ORDER BY r.priority ASC, t.sort_order ASC, t.id ASC`).all();
	const map = /* @__PURE__ */ new Map();
	for (const r of rows) {
		const key = (0, node_path.resolve)(r.path);
		const hit = map.get(key);
		if (hit) hit.keywords.add(r.keyword);
		else map.set(key, {
			path: r.path,
			keywords: /* @__PURE__ */ new Set([r.keyword])
		});
	}
	return [...map.values()].map((v) => {
		const info = healthOf(v.path);
		return {
			path: v.path,
			health: info.health,
			freeBytes: info.freeBytes,
			totalBytes: info.totalBytes,
			ruleKeywords: [...v.keywords]
		};
	});
}
var PLAIN_CODEC, dbRef, codec, now, bool, bit, HEALTH_TTL_MS, healthCache, STATUS_ZH, REPLY_ZH, DELIVERY_ZH;
var init_repos = __esmMin((() => {
	PLAIN_CODEC = {
		encrypt: (plain) => plain ? Buffer.from(`plain:${plain}`, "utf8") : Buffer.alloc(0),
		decrypt: (buf) => {
			if (!buf || buf.length === 0) return "";
			const s = Buffer.from(buf).toString("utf8");
			return s.startsWith("plain:") ? s.slice(6) : "";
		}
	};
	dbRef = null;
	codec = PLAIN_CODEC;
	now = () => Date.now();
	bool = (v) => !!v;
	bit = (v) => v ? 1 : 0;
	HEALTH_TTL_MS = 3e4;
	healthCache = /* @__PURE__ */ new Map();
	STATUS_ZH = {
		ignored_no_keyword: "未命中关键词",
		ignored_type: "附件类型不符",
		queued: "处理中",
		partial: "部分成功·待重试",
		done: "已完成",
		failed: "失败"
	};
	REPLY_ZH = {
		disabled: "已关闭",
		pending: "等待中",
		suppressed: "已抑制",
		sent: "已回信",
		failed: "回信失败"
	};
	DELIVERY_ZH = {
		pending: "排队中",
		copying: "复制中",
		done: "已写入",
		retry_wait: "等待重试",
		failed: "失败",
		skipped: "已跳过"
	};
}));
// src/main/ipc.ts
/**
* IPC 入口：渲染层 → 主进程。所有 handler 做参数校验、错误兜底，并统一返回可序列化结构。
* 账户/规则/记录等 CRUD 直接走 repos；网络类操作（测试连接、立即检查）走 backend。
*/
init_repos();
var ctx = null;
function requireBackend() {
	const b = ctx?.getBackend();
	if (!b) throw new Error("后端尚未启动完成，请稍后再试");
	return b;
}
function fail(e) {
	const msg = e instanceof Error ? e.message : String(e);
	throw new Error(msg);
}
function registerIpc(context) {
	ctx = context;
	electron.ipcMain.handle(IPC.accountList, () => listAccounts());
	electron.ipcMain.handle(IPC.accountCreate, async (_e, input) => {
		try {
			const acc = createAccount(input);
			ctx?.broadcast({
				type: "account:changed",
				account: acc
			});
			ctx?.broadcast({ type: "dashboard:changed" });
			return acc;
		} catch (e) {
			fail(e);
		}
	});
	electron.ipcMain.handle(IPC.accountUpdate, async (_e, id, input) => {
		try {
			const acc = updateAccount(id, input);
			ctx?.broadcast({
				type: "account:changed",
				account: acc
			});
			return acc;
		} catch (e) {
			fail(e);
		}
	});
	electron.ipcMain.handle(IPC.accountDelete, async (_e, id) => {
		try {
			deleteAccount(id);
			ctx?.broadcast({ type: "dashboard:changed" });
		} catch (e) {
			fail(e);
		}
	});
	electron.ipcMain.handle(IPC.accountTest, async (_e, input) => {
		try {
			return await requireBackend().testAccount(input);
		} catch (e) {
			fail(e);
		}
	});
	electron.ipcMain.handle(IPC.accountTestSaved, async (_e, id) => {
		try {
			return await requireBackend().testSavedAccount(id);
		} catch (e) {
			fail(e);
		}
	});
	electron.ipcMain.handle(IPC.accountToggle, async (_e, id, enabled) => {
		try {
			const acc = setAccountEnabled(id, enabled);
			ctx?.broadcast({
				type: "account:changed",
				account: acc
			});
			if (enabled) requireBackend().scheduler.resume();
			return acc;
		} catch (e) {
			fail(e);
		}
	});
	electron.ipcMain.handle(IPC.ruleList, () => listRules());
	electron.ipcMain.handle(IPC.ruleCreate, async (_e, input) => {
		try {
			const rule = createRule(input);
			ctx?.broadcast({ type: "rules:changed" });
			return rule;
		} catch (e) {
			fail(e);
		}
	});
	electron.ipcMain.handle(IPC.ruleUpdate, async (_e, id, input) => {
		try {
			const rule = updateRule(id, input);
			ctx?.broadcast({ type: "rules:changed" });
			return rule;
		} catch (e) {
			fail(e);
		}
	});
	electron.ipcMain.handle(IPC.ruleDelete, async (_e, id) => {
		try {
			deleteRule(id);
			ctx?.broadcast({ type: "rules:changed" });
		} catch (e) {
			fail(e);
		}
	});
	electron.ipcMain.handle(IPC.ruleToggle, async (_e, id, enabled) => {
		try {
			const rule = setRuleEnabled(id, enabled);
			ctx?.broadcast({ type: "rules:changed" });
			return rule;
		} catch (e) {
			fail(e);
		}
	});
	electron.ipcMain.handle(IPC.ruleReorder, async (_e, ids) => {
		try {
			reorderRules(ids);
			ctx?.broadcast({ type: "rules:changed" });
		} catch (e) {
			fail(e);
		}
	});
	electron.ipcMain.handle(IPC.ruleTargetsHealth, () => listRulesWithHealth());
	electron.ipcMain.handle(IPC.recordsList, (_e, q) => listRecords(q));
	electron.ipcMain.handle(IPC.recordsRetry, async (_e, messageId, deliveryId) => {
		try {
			await requireBackend().retryMessage(messageId, deliveryId);
			ctx?.broadcast({ type: "dashboard:changed" });
		} catch (e) {
			fail(e);
		}
	});
	electron.ipcMain.handle(IPC.recordsOpenFolder, async (_e, messageId, deliveryId) => {
		const dir = folderOfRecord(messageId, deliveryId);
		if (!dir) throw new Error("没有可打开的文件夹");
		await electron.shell.openPath(dir);
	});
	electron.ipcMain.handle(IPC.recordsExport, async (_e, q) => {
		const win = ctx?.getWindow();
		const res = await electron.dialog.showSaveDialog(win, {
			title: "导出下载记录",
			defaultPath: (0, node_path.join)(electron.app.getPath("downloads"), `mailharbor-records-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.csv`),
			filters: [{
				name: "CSV",
				extensions: ["csv"]
			}]
		});
		if (res.canceled || !res.filePath) return null;
		const csv = recordsToCsv(listRecords({
			...q,
			page: 1,
			pageSize: 1e5
		}).rows);
		await (0, node_fs_promises.writeFile)(res.filePath, "﻿" + csv, "utf8");
		return { path: res.filePath };
	});
	electron.ipcMain.handle(IPC.recordsClear, async () => {
		getDb().prepare("DELETE FROM messages").run();
		ctx?.broadcast({ type: "dashboard:changed" });
	});
	electron.ipcMain.handle(IPC.replyTest, async (_e, to) => {
		try {
			return await requireBackend().testReply(to);
		} catch (e) {
			return {
				ok: false,
				message: e instanceof Error ? e.message : String(e)
			};
		}
	});
	electron.ipcMain.handle(IPC.dashboard, () => buildDashboard());
	electron.ipcMain.handle(IPC.listeningSet, async (_e, on) => {
		const b = requireBackend();
		if (on) {
			await b.scheduler.resume();
			b.bus.emit("event", {
				type: "listening:changed",
				listening: true
			});
		} else {
			b.scheduler.pause();
			b.bus.emit("event", {
				type: "listening:changed",
				listening: false
			});
		}
		return on;
	});
	electron.ipcMain.handle(IPC.checkNow, async () => {
		await requireBackend().scheduler.checkNow();
	});
	electron.ipcMain.handle(IPC.settingsGet, () => readSettings());
	electron.ipcMain.handle(IPC.settingsSave, async (_e, s) => {
		for (const [k, v] of Object.entries(s)) setSetting(k, v);
		setSetting("pollIntervalSec", Math.max(15, Math.min(3600, Number(s.pollIntervalSec) || 30)));
		if (electron.app.isPackaged) electron.app.setLoginItemSettings({
			openAtLogin: !!s.autostart,
			args: ["--autostart"]
		});
		ctx?.broadcast({ type: "dashboard:changed" });
		return readSettings();
	});
	electron.ipcMain.handle(IPC.pickFolder, async () => {
		const win = ctx?.getWindow();
		const res = await electron.dialog.showOpenDialog(win, {
			title: "选择存储文件夹",
			properties: ["openDirectory", "createDirectory"]
		});
		return res.canceled ? null : res.filePaths[0] ?? null;
	});
	electron.ipcMain.handle(IPC.openPath, async (_e, p) => {
		await electron.shell.openPath(p);
	});
	electron.ipcMain.handle(IPC.appInfo, () => ({
		version: electron.app.getVersion(),
		userData: electron.app.getPath("userData"),
		listening: ctx?.getBackend()?.scheduler.isListening() ?? false
	}));
}
function readSettings() {
	const out = {};
	for (const key of Object.keys(DEFAULT_SETTINGS)) out[key] = getSetting(key);
	return out;
}
function buildDashboard() {
	getDb();
	const dashboard = dashboardStats();
	const accounts = listAccounts();
	const recent = listRecords({
		page: 1,
		pageSize: 8
	}).rows;
	const b = ctx?.getBackend();
	const startedAt = globalThis.__mhStartedAt;
	return {
		listening: b?.scheduler.isListening() ?? false,
		accounts,
		todayMessages: dashboard.todayMessages,
		todayMatched: dashboard.todayMatched,
		todayFiles: dashboard.todayFiles,
		todayFailed: dashboard.todayFailed,
		pendingRetry: dashboard.pendingRetry,
		disks: listDisks(),
		recent,
		pollIntervalSec: getSetting("pollIntervalSec") ?? 30,
		nextCheckAt: b?.scheduler.nextCheckAt() ?? null,
		uptimeMs: startedAt ? Date.now() - startedAt : 0
	};
}
function disposeIpc() {
	for (const ch of Object.values(IPC)) electron.ipcMain.removeHandler(ch);
}
// src/main/file-writer.ts
/**
* 附件文件名解码 + 安全清洗 + 落盘（临时文件 + 原子改名）。
*
* 中文文件名三大来源（ARCHITECTURE §2.5）：
*  1) RFC 2047 encoded-word：=?UTF-8?B?...?= / =?GBK?Q?...?=
*  2) RFC 2231：filename*=UTF-8''%E4%B8%AD...
*  3) 客户端直接发 GBK/GB18030 原始字节
*/
/** RFC 2047 解码 */
function decodeRfc2047(input) {
	if (!input) return "";
	return input.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, charset, enc, text) => {
		try {
			let buf;
			if (enc.toUpperCase() === "B") buf = Buffer.from(text, "base64");
			else buf = Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_x, h) => String.fromCharCode(parseInt(h, 16))), "binary");
			const cs = charset.toLowerCase().replace("gb2312", "gbk").replace("gb18030", "gbk");
			try {
				return new TextDecoder(cs === "gbk" ? "gb18030" : cs, { fatal: true }).decode(buf);
			} catch {
				return new TextDecoder("utf-8", { fatal: false }).decode(buf);
			}
		} catch {
			return text;
		}
	});
}
/** RFC 2231 解码：filename*=UTF-8''%E4%B8%AD%... */
function decodeRfc2231(value) {
	const m = value.match(/^([^']*)''(.*)$/);
	if (!m) return decodeURIComponentSafe(value);
	const charset = (m[1] || "utf-8").toLowerCase();
	const rest = decodeURIComponentSafe(m[2]);
	if (charset === "utf-8" || charset === "us-ascii") return rest;
	try {
		const bytes = Buffer.from(unescapePercent(m[2]), "binary");
		return new TextDecoder(charset === "gbk" || charset === "gb2312" ? "gb18030" : charset).decode(bytes);
	} catch {
		return rest;
	}
}
function unescapePercent(s) {
	return s.replace(/%([0-9A-Fa-f]{2})/g, (_x, h) => String.fromCharCode(parseInt(h, 16)));
}
function decodeURIComponentSafe(s) {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}
/** 综合解码：先 RFC 2047，再 RFC 2231，最后尝试 GBK 原始字节 */
function decodeFilename(raw, mimeParam) {
	if (!raw) return "";
	if (Buffer.isBuffer(raw)) {
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(raw);
		} catch {}
		try {
			return new TextDecoder("gb18030").decode(raw);
		} catch {
			return raw.toString("latin1");
		}
	}
	let name = raw;
	if (/=\?.*\?[BbQq]\?.*\?=/.test(name)) name = decodeRfc2047(name);
	if (/^[^']*''/.test(name) || /%[0-9A-Fa-f]{2}/.test(name)) name = decodeRfc2231(name);
	if (mimeParam) name = name || mimeParam;
	if (/[\u0080-\u00ff]/.test(name) && !/[\u4e00-\u9fff]/.test(name)) try {
		const gbk = new TextDecoder("gb18030").decode(Buffer.from(name, "latin1"));
		if (/[\u4e00-\u9fff]/.test(gbk)) name = gbk;
	} catch {}
	return name.trim();
}
/** 安全清洗：去掉路径、非法字符、保留名、结尾点空格，UTF-16 截断 */
function sanitizeFilename(name, fallback = "attachment") {
	let base = (0, node_path.basename)((name ?? "").replace(/\\/g, "/"));
	base = base.replace(ILLEGAL, "_").replace(/[\s.]+$/g, "").trim();
	if (!base || base === "." || base === "..") base = fallback;
	if (RESERVED.test(base)) base = `_${base}`;
	const ext = (0, node_path.extname)(base);
	let stem = base.slice(0, base.length - ext.length);
	if (stem.length > 160) stem = stem.slice(0, 160);
	return stem + ext.toLowerCase();
}
/** 目标目录里重名时生成 "name (2).ext"、"name (3).ext"… */
async function uniqueNameInDir(dir, filename) {
	const ext = (0, node_path.extname)(filename);
	const stem = filename.slice(0, filename.length - ext.length);
	for (let i = 1; i < 1e3; i++) {
		const candidate = i === 1 ? filename : `${stem} (${i})${ext}`;
		try {
			await (0, node_fs_promises.access)((0, node_path.join)(dir, candidate), node_fs.constants.F_OK);
			continue;
		} catch {
			return candidate;
		}
	}
	return `${stem} (${Date.now()})${ext}`;
}
async function pathExists(p) {
	try {
		await (0, node_fs_promises.access)(p, node_fs.constants.F_OK);
		return true;
	} catch {
		return false;
	}
}
/** 磁盘剩余空间（字节）；不可用时返回 null */
async function diskFree(path) {
	try {
		await (0, node_fs_promises.mkdir)(path, { recursive: true });
		if (!(await (0, node_fs_promises.stat)(path)).isDirectory()) return null;
		const { statfs } = await import("node:fs/promises");
		const fsStat = await statfs(path);
		return {
			free: fsStat.bavail * fsStat.bsize,
			total: fsStat.blocks * fsStat.bsize
		};
	} catch {
		return null;
	}
}
/**
* 把临时文件复制到目标目录：同目录写 .part → 原子 rename → 返回最终文件名。
* 重名自动加 (2)。空间不足/无权限抛指定错误码。
*/
async function copyIntoDir(tmpFile, targetDir, filename, minFreeBytes = 0) {
	const dir = (0, node_path.resolve)(targetDir);
	try {
		await (0, node_fs_promises.mkdir)(dir, { recursive: true });
	} catch (e) {
		throw Object.assign(/* @__PURE__ */ new Error(`目标目录不可用：${dir}`), { code: "PATH_UNAVAILABLE" });
	}
	const space = await diskFree(dir);
	if (!space) throw Object.assign(/* @__PURE__ */ new Error(`目标目录不可用：${dir}`), { code: "PATH_UNAVAILABLE" });
	const src = await (0, node_fs_promises.stat)(tmpFile);
	if (space.free < Math.max(src.size * 1.2, minFreeBytes)) throw Object.assign(/* @__PURE__ */ new Error("目标磁盘空间不足"), { code: "NO_SPACE" });
	const finalName = await uniqueNameInDir(dir, filename);
	const finalPath = (0, node_path.join)(dir, finalName);
	const partPath = (0, node_path.join)(dir, `.mh-${process.pid}-${Date.now()}.part`);
	try {
		await (0, node_fs_promises.copyFile)(tmpFile, partPath);
		await (0, node_fs_promises.rename)(partPath, finalPath);
	} catch (e) {
		await (0, node_fs_promises.rm)(partPath, { force: true }).catch(() => {});
		const code = e.code;
		throw Object.assign(e, { code: code === "ENOSPC" ? "NO_SPACE" : code === "EACCES" || code === "EPERM" ? "ACCESS_DENIED" : "COPY_FAILED" });
	}
	return {
		savedPath: finalPath,
		savedName: finalName,
		size: src.size
	};
}
var ILLEGAL, RESERVED;
var init_file_writer = __esmMin((() => {
	ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;
	RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
}));
// src/main/log.ts
function setLogLevel(level) {
	if (level === "debug" || level === "info" || level === "warn" || level === "error") currentLevel = level;
}
/** 日志脱敏：密码/授权码/认证串/token 一律掩码 */
function redact(input) {
	let out = input ?? "";
	for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
	return out;
}
function serializeDetail(detail) {
	if (detail === void 0) return "";
	if (detail instanceof Error) return ` ${detail.name}: ${detail.message}`;
	try {
		const s = typeof detail === "string" ? detail : JSON.stringify(detail);
		return s ? ` ${s.length > 2e3 ? s.slice(0, 2e3) + "…" : s}` : "";
	} catch {
		return "";
	}
}
function createLogger(scope) {
	const write = (level, msg, detail) => {
		if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[currentLevel]) return;
		const line = `[${(/* @__PURE__ */ new Date()).toISOString()}] [${level.toUpperCase()}] [${scope}] ${redact(msg)}${redact(serializeDetail(detail))}`;
		if (level === "error") console.error(line);
		else if (level === "warn") console.warn(line);
		else console.log(line);
	};
	return {
		debug: (m, d) => write("debug", m, d),
		info: (m, d) => write("info", m, d),
		warn: (m, d) => write("warn", m, d),
		error: (m, d) => write("error", m, d),
		setLevel: (l) => setLogLevel(l)
	};
}
var LEVEL_WEIGHT, currentLevel, SECRET_PATTERNS;
var init_log = __esmMin((() => {
	LEVEL_WEIGHT = {
		debug: 10,
		info: 20,
		warn: 30,
		error: 40
	};
	currentLevel = "info";
	SECRET_PATTERNS = [
		[/((?:pass(?:word)?|pwd|authorization|auth|token|secret|授权码|密码)\s*[=:：]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1***"],
		[/Basic\s+[A-Za-z0-9+/=]{8,}/g, "Basic ***"],
		[/(?<![A-Za-z0-9+/=_-])([A-Za-z0-9=_-]{32,})(?![A-Za-z0-9+/=_-])/g, "***"]
	];
}));
// src/main/dispatcher.ts
/**
* 投递调度器：附件 × 目标路径（deliveries 状态机 + 重试队列 + 启动对账）。
*
* 核心规则（ARCHITECTURE §6.3）：
*  - 跨路径并行、单路径串行，全局并发上限 4
*  - 已 done 的 delivery 永不重做（A 盘成功、B 盘失败 → 只重试 B）
*  - 路径不可用 / 空间不足 → retry_wait，**不消耗 attempts**，60s 后再查
*  - 复制失败 → attempts+1，退避 15s→30s→1m→2m→5m→10m→30m→1h；超过 retryMaxAttempts(默认8) → failed
*  - 启动对账：copying 状态根据目标目录里已存在文件（size+sha256）认领 done，否则重做
*/
/** 第 n 次失败后的等待时间（n 从 1 开始） */
function retryDelayMs(attempts) {
	const idx = Math.max(0, Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1));
	return RETRY_DELAYS_MS[idx];
}
function classifyCopyError(e) {
	const err = e;
	const code = typeof err?.code === "string" ? err.code : "COPY_FAILED";
	const message = e instanceof Error ? e.message : String(e);
	return {
		code: code === "ENOSPC" ? "NO_SPACE" : code === "EACCES" || code === "EPERM" ? "ACCESS_DENIED" : code === "ENOENT" || code === "ENOTDIR" ? "PATH_UNAVAILABLE" : PATH_CODES.has(code) ? code : "COPY_FAILED",
		message
	};
}
/** 写盘前置检查：目录存在、是目录、可写、剩余空间 ≥ 附件 × 1.2 */
async function precheckTarget(targetPath, neededBytes = 0) {
	if (!targetPath) return {
		ok: false,
		code: "PATH_UNAVAILABLE",
		message: "目标文件夹为空"
	};
	try {
		if (!(await (0, node_fs_promises.stat)(targetPath)).isDirectory()) return {
			ok: false,
			code: "PATH_UNAVAILABLE",
			message: `目标路径不是文件夹：${targetPath}`
		};
	} catch {
		return {
			ok: false,
			code: "PATH_UNAVAILABLE",
			message: `目标文件夹不可用（盘未挂载或无权限）：${targetPath}`
		};
	}
	const space = await diskFree(targetPath);
	if (!space) return {
		ok: false,
		code: "PATH_UNAVAILABLE",
		message: `无法读取磁盘剩余空间：${targetPath}`
	};
	const need = Math.max(neededBytes * 1.2, MIN_FREE_BYTES);
	if (space.free < need) return {
		ok: false,
		code: "NO_SPACE",
		message: `目标磁盘空间不足：剩余 ${(space.free / 1024 / 1024).toFixed(0)}MB，至少需要 ${(need / 1024 / 1024).toFixed(0)}MB`
	};
	return { ok: true };
}
function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
async function sha256OfFile(path) {
	const hash = (0, node_crypto.createHash)("sha256");
	await new Promise((resolvePromise, reject) => {
		const stream = (0, node_fs.createReadStream)(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("end", () => resolvePromise());
		stream.on("error", reject);
	});
	return hash.digest("hex");
}
var RETRY_DELAYS_MS, PATH_RECHECK_MS, TICK_MS$1, TMP_MAX_AGE_MS, MIN_FREE_BYTES, PATH_CODES, Dispatcher;
var init_dispatcher = __esmMin((() => {
	init_repos();
	init_file_writer();
	init_log();
	RETRY_DELAYS_MS = [
		15e3,
		3e4,
		6e4,
		12e4,
		3e5,
		6e5,
		18e5,
		36e5
	];
	PATH_RECHECK_MS = 6e4;
	TICK_MS$1 = 3e3;
	TMP_MAX_AGE_MS = 864e5;
	MIN_FREE_BYTES = 2097152;
	PATH_CODES = /* @__PURE__ */ new Set([
		"PATH_UNAVAILABLE",
		"NO_SPACE",
		"ACCESS_DENIED"
	]);
	Dispatcher = class {
		deps;
		log;
		timer = null;
		ticking = false;
		stopped = true;
		active = /* @__PURE__ */ new Map();
		kickScheduled = false;
		/** 全部 delivery 进入终态时回调（pipeline 聚合状态 + 触发回信） */
		onSettled = null;
		constructor(deps) {
			this.deps = deps;
			this.log = deps.logger ?? createLogger("dispatcher");
		}
		now() {
			return this.deps.now ? this.deps.now() : Date.now();
		}
		maxAttempts() {
			const raw = Number(this.deps.getSetting("retryMaxAttempts") ?? 8);
			return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8;
		}
		start() {
			if (this.timer) return;
			this.stopped = false;
			this.timer = setInterval(() => void this.runOnce(), TICK_MS$1);
			this.runOnce();
		}
		stop() {
			this.stopped = true;
			if (this.timer) clearInterval(this.timer);
			this.timer = null;
		}
		/** 有新的 delivery 入队时尽快跑一轮（不阻塞调用方） */
		schedule() {
			if (this.kickScheduled) return;
			this.kickScheduled = true;
			setTimeout(() => {
				this.kickScheduled = false;
				this.runOnce();
			}, 30);
		}
		/**
		* 扫一轮到期队列：全局并发 ≤4、同目标路径串行（路径 A 与路径 B 可并行）。
		*/
		async runOnce() {
			if (this.ticking) return;
			this.ticking = true;
			try {
				const due = dueDeliveries(this.now());
				if (due.length === 0) return;
				const concurrency = Math.max(1, this.deps.concurrency ?? 4);
				const busyPaths = /* @__PURE__ */ new Set();
				let cursor = 0;
				const launch = () => {
					while (cursor < due.length && this.active.size < concurrency) {
						const row = due[cursor++];
						if (this.active.has(row.id)) continue;
						if (busyPaths.has(row.target_path)) continue;
						busyPaths.add(row.target_path);
						const task = this.processDelivery(row).catch((e) => this.log.warn(`delivery #${row.id} 处理异常`, e instanceof Error ? e.message : String(e))).finally(() => {
							busyPaths.delete(row.target_path);
							this.active.delete(row.id);
							launch();
						});
						this.active.set(row.id, task);
					}
				};
				launch();
				while (this.active.size > 0) await Promise.all([...this.active.values()]);
			} finally {
				this.ticking = false;
			}
		}
		async processDelivery(row) {
			const messageId = row.message_id;
			const attachment = getAttachment(row.attachment_id);
			if (!attachment || !attachment.tmp_path || !await pathExists(attachment.tmp_path)) {
				const attempts = row.attempts + 1;
				markDeliveryFailed(row.id, {
					errorCode: "TMP_MISSING",
					error: "本地临时附件已丢失，无法投递（可在这条记录上点重试）",
					attempts
				});
				this.log.warn(`delivery #${row.id} 临时文件缺失：${attachment?.tmp_path ?? "-"}`);
				this.afterDelivery(row, "delivery:changed");
				return;
			}
			const size = attachment.size ?? 0;
			const pre = await precheckTarget(row.target_path, size);
			if (!pre.ok) {
				markDeliveryRetry(row.id, {
					errorCode: pre.code ?? "PATH_UNAVAILABLE",
					error: pre.message ?? "目标路径不可用",
					nextRetryAt: this.now() + PATH_RECHECK_MS,
					attempts: row.attempts
				});
				this.afterDelivery(row, "delivery:changed");
				return;
			}
			updateDeliveryState(row.id, "copying", {
				startedAt: this.now(),
				errorCode: null,
				error: null
			});
			this.deps.emit({
				type: "delivery:changed",
				messageId
			});
			const filename = sanitizeFilename(attachment.filename || (0, node_path.basename)(attachment.tmp_path), "attachment");
			try {
				const copied = await copyIntoDir(attachment.tmp_path, row.target_path, filename);
				markDeliveryDone(row.id, {
					savedPath: copied.savedPath,
					savedName: copied.savedName,
					size: copied.size,
					sha256: attachment.sha256
				});
				this.log.info(`已落盘 ${copied.savedPath}`);
				this.afterDelivery(row, "delivery:changed");
				this.deps.emit({ type: "dashboard:changed" });
				return;
			} catch (e) {
				const { code, message } = classifyCopyError(e);
				if (PATH_CODES.has(code)) {
					markDeliveryRetry(row.id, {
						errorCode: code,
						error: message,
						nextRetryAt: this.now() + PATH_RECHECK_MS,
						attempts: row.attempts
					});
					this.log.warn(`投递 #${row.id} 路径不可用（不消耗重试次数）：${code} ${message}`);
				} else {
					const attempts = row.attempts + 1;
					if (attempts >= this.maxAttempts()) {
						markDeliveryFailed(row.id, {
							errorCode: code,
							error: message,
							attempts
						});
						this.log.error(`投递 #${row.id} 达到最大重试次数，标记失败：${message}`);
					} else {
						markDeliveryRetry(row.id, {
							errorCode: code,
							error: message,
							nextRetryAt: this.now() + retryDelayMs(attempts),
							attempts
						});
						this.log.warn(`投递 #${row.id} 第 ${attempts} 次失败，将重试：${message}`);
					}
				}
				this.afterDelivery(row, "delivery:changed");
				this.deps.emit({ type: "dashboard:changed" });
			}
		}
		/** 状态变化后：刷新聚合状态，若全部进入终态则通知 pipeline（聚合 + 回信） */
		afterDelivery(row, event) {
			this.deps.emit({
				type: event,
				messageId: row.message_id
			});
			this.refreshMessageStatus(row.message_id);
		}
		/** 聚合 messages.status 并推送记录行；全部终态时回调 onSettled */
		refreshMessageStatus(messageId) {
			const agg = deliveryAggregate(messageId);
			if (agg.total === 0) return;
			const before = getMessage(messageId);
			if (!before) return;
			let next;
			if (agg.allTerminal) {
				if (agg.requiredFailed > 0 || agg.failed > 0 && agg.done === 0) next = "failed";
				else next = "done";
			} else if (agg.failed > 0 || agg.retryWait > 0 || agg.done > 0 && (agg.pending > 0 || agg.copying > 0)) next = "partial";
			else next = "queued";
			if (next !== before.status) {
				updateMessageStatus(messageId, next, next === "failed" ? before.error ?? "存在未完成的必达路径" : null);
				const record = getRecordById(messageId);
				if (record) this.deps.emit({
					type: "message:upserted",
					record
				});
				this.log.info(`邮件 #${messageId} 状态 ${before.status} → ${next}`);
			}
			if (agg.allTerminal && before.status !== next) try {
				this.onSettled?.(messageId);
			} catch (e) {
				this.log.warn(`settle 回调异常 #${messageId}`, e instanceof Error ? e.message : String(e));
			}
		}
		/** 手动重试：deliveryId 省略时重试该邮件全部失败路径 */
		async retryDelivery(messageId, deliveryId) {
			if (resetDeliveriesForRetry(messageId, deliveryId) > 0) {
				updateMessageStatus(messageId, "queued", null);
				const record = getRecordById(messageId);
				if (record) this.deps.emit({
					type: "message:upserted",
					record
				});
				this.schedule();
			} else this.schedule();
			this.deps.emit({ type: "dashboard:changed" });
		}
		/**
		* 启动对账：
		*  1) copying 状态的投递——目标目录里已有 size+sha256 一致的文件则认领为 done，否则重置 pending 重做
		*  2) 清理 tmp 目录下 >24h 的 .part 残留
		*/
		async reconcile() {
			let adopted = 0;
			let reset = 0;
			const affectedMessages = /* @__PURE__ */ new Set();
			for (const row of copyingDeliveries()) {
				affectedMessages.add(row.message_id);
				const attachment = getAttachment(row.attachment_id);
				if (!attachment) {
					markDeliveryFailed(row.id, {
						errorCode: "ATTACHMENT_MISSING",
						error: "附件记录缺失",
						attempts: row.attempts
					});
					reset++;
					continue;
				}
				const found = await this.findAdoptableFile(row.target_path, sanitizeFilename(attachment.filename, "attachment"), attachment.size ?? 0, attachment.sha256);
				if (found) {
					markDeliveryDone(row.id, {
						savedPath: found.path,
						savedName: found.name,
						size: found.size,
						sha256: attachment.sha256
					});
					this.log.info(`对账认领已落盘文件：${found.path}`);
					adopted++;
				} else reset++;
			}
			if (reset > 0) resetCopyingDeliveries();
			const tmpCleaned = await this.cleanupTmp();
			for (const messageId of affectedMessages) this.refreshMessageStatus(messageId);
			return {
				adopted,
				reset,
				tmpCleaned
			};
		}
		async findAdoptableFile(dir, filename, expectedSize, sha256) {
			if (!dir || !await pathExists(dir)) return null;
			let entries;
			try {
				entries = await (0, node_fs_promises.readdir)(dir);
			} catch {
				return null;
			}
			const ext = (0, node_path.extname)(filename);
			const stem = filename.slice(0, filename.length - ext.length);
			const pattern = new RegExp(`^${escapeRegExp(stem)}( \\(\\d+\\))?${escapeRegExp(ext)}$`);
			for (const name of entries) {
				if (!pattern.test(name)) continue;
				const full = (0, node_path.join)(dir, name);
				try {
					const st = await (0, node_fs_promises.stat)(full);
					if (!st.isFile()) continue;
					if (expectedSize > 0 && st.size !== expectedSize) continue;
					if (sha256) {
						if (await sha256OfFile(full) !== sha256) continue;
					}
					return {
						path: full,
						name,
						size: st.size
					};
				} catch {
					continue;
				}
			}
			return null;
		}
		async cleanupTmp() {
			const dir = this.deps.tmpDir;
			let count = 0;
			let entries;
			try {
				entries = await (0, node_fs_promises.readdir)(dir);
			} catch {
				return 0;
			}
			const deadline = this.now() - TMP_MAX_AGE_MS;
			for (const name of entries) {
				if (!name.endsWith(".part") && !name.endsWith(".tmp")) continue;
				const full = (0, node_path.join)(dir, name);
				try {
					if ((await (0, node_fs_promises.stat)(full)).mtimeMs < deadline) {
						await (0, node_fs_promises.rm)(full, { force: true });
						count++;
					}
				} catch {}
			}
			if (count > 0) this.log.info(`清理临时文件 ${count} 个`);
			return count;
		}
	};
}));
// src/main/rule-engine.ts
function normalize(s) {
	if (!s) return "";
	let out = "";
	for (const ch of s) out += FULL_TO_HALF[ch] ?? ch;
	return out.toLowerCase().replace(/\s+/g, "").trim();
}
/** 只做全角归一 + 小写 + 折叠空白（保留分隔信息，供 exact 匹配用） */
function loosen(s) {
	if (!s) return "";
	let out = "";
	for (const ch of s) out += FULL_TO_HALF[ch] ?? ch;
	return out.toLowerCase().replace(/\s+/g, " ").trim();
}
/** 去掉 RE:/FWD: 等前缀（可能多层嵌套） */
function stripSubjectPrefix(subject) {
	let s = subject ?? "";
	for (let i = 0; i < 6; i++) {
		const before = s;
		s = s.replace(SUBJECT_PREFIX, "");
		if (s === before) break;
	}
	return s;
}
function matchOne(rule, msg) {
	const kw = normalize(rule.keyword);
	if (!kw) return null;
	const subjectStripped = stripSubjectPrefix(msg.subject);
	const subject = normalize(subjectStripped);
	if (subject) {
		if (rule.mode === "exact" ? exactHit(loosen(subjectStripped), kw) : subject.includes(kw)) return {
			ruleId: rule.id,
			source: "subject"
		};
	}
	if (rule.scope === "subject_body" && msg.body) {
		const body = normalize(msg.body);
		if (rule.mode === "exact" ? exactHit(loosen(msg.body), kw) : body.includes(kw)) return {
			ruleId: rule.id,
			source: "body"
		};
	}
	return null;
}
/**
* 精确匹配：把"关键词"视为业务标记（标题里的品类标记），命中规则：
*  1) 整个主题就是关键词：`原图+卡套`
*  2) 主题以「关键词 + 分隔符」开头：`原图+卡套 追加: POD_ORDER_20486`、`原图+卡套-打样`、`原图+卡套: 第2批`
*  3) 主题以「关键词 + 中文业务说明」开头（客户常写「原图+卡套追加」「原图+卡套打样」）：
*     只要关键词后紧跟的是非字母数字（中文/标点/空格）就认为它是"关键词 + 说明"，仍算命中
*  4) 反例：「原图+卡套盒」「原图+卡套子」不算（关键词后直接接字母/数字/汉字修饰，属于不同品类）
* 实现要点：**不能先 normalize 掉空格**，否则 `原图+卡套 追加` 会变成 `原图+卡套追加` 丢失分隔信息。
* 所以 subject 传入的是"只做全角归一 + 小写 + 折叠空白"的版本，再单独比较关键词的紧致形式。
*/
function exactHit(subjectLoose, kw) {
	const kwLoose = kw.replace(/\s+/g, "");
	const looseNoSpace = subjectLoose.replace(/\s+/g, "");
	if (looseNoSpace === kwLoose) return true;
	if (!looseNoSpace.startsWith(kwLoose)) return false;
	const rest = looseNoSpace.slice(kwLoose.length);
	if (!rest) return true;
	const ch = rest[0];
	if (/[\u4e00-\u9fff]/.test(ch)) return /^(追加|打样|补发|补|确认|收尾|返|重|新|老|加|第|再|更)/.test(rest) === true;
	return /^[\s\-_:：|/.、,，(（\[【0-9]/.test(ch);
}
/** 返回命中的规则（已按 priority 升序排序，priority 数字小的优先） */
function matchRules(rules, msg, strategy = "all") {
	const active = rules.filter((r) => r.enabled).sort((a, b) => a.priority - b.priority);
	const hits = [];
	for (const rule of active) {
		const hit = matchOne(rule, msg);
		if (hit) {
			hits.push(hit);
			if (strategy === "priority") break;
		}
	}
	return hits;
}
function extOf(filename) {
	const i = filename.lastIndexOf(".");
	return i >= 0 ? filename.slice(i + 1).toLowerCase() : "";
}
function isAllowedAttachment(filename, mimeType, fileTypes) {
	const allowed = fileTypes.map((t) => t.toLowerCase().replace(/^\./, ""));
	const ext = extOf(filename);
	if (ext && allowed.includes(ext)) return true;
	const mime = (mimeType ?? "").toLowerCase();
	if (!mime) return false;
	return allowed.some((t) => (MIME_OK[t] ?? []).includes(mime));
}
var FULL_TO_HALF, SUBJECT_PREFIX, MIME_OK;
var init_rule_engine = __esmMin((() => {
	FULL_TO_HALF = {
		"＋": "+",
		"－": "-",
		"／": "/",
		"（": "(",
		"）": ")",
		"：": ":",
		"　": "",
		"\xA0": "",
		"​": "",
		"‌": "",
		"‍": "",
		"﻿": ""
	};
	SUBJECT_PREFIX = /^\s*(re|fw|fwd|aw|sv|答复|回复|转发)\s*[：:]\s*/i;
	MIME_OK = {
		zip: [
			"application/zip",
			"application/x-zip-compressed",
			"application/octet-stream",
			"multipart/x-zip"
		],
		tif: [
			"image/tiff",
			"image/tif",
			"application/octet-stream"
		],
		tiff: [
			"image/tiff",
			"image/tif",
			"application/octet-stream"
		],
		jpg: [
			"image/jpeg",
			"image/pjpeg",
			"application/octet-stream"
		],
		jpeg: [
			"image/jpeg",
			"image/pjpeg",
			"application/octet-stream"
		],
		png: ["image/png", "application/octet-stream"],
		pdf: ["application/pdf", "application/octet-stream"],
		psd: ["image/vnd.adobe.photoshop", "application/octet-stream"],
		ai: [
			"application/postscript",
			"application/illustrator",
			"application/octet-stream"
		]
	};
}));
// src/main/pipeline.ts
var DEFAULT_FALLBACK_TYPES, MailPipeline;
var init_pipeline = __esmMin((() => {
	init_repos();
	init_rule_engine();
	init_file_writer();
	init_log();
	DEFAULT_FALLBACK_TYPES = [
		"zip",
		"tif",
		"tiff"
	];
	MailPipeline = class {
		deps;
		log;
		constructor(deps) {
			this.deps = deps;
			this.log = deps.logger ?? createLogger("pipeline");
		}
		setting(key) {
			return this.deps.getSetting(key);
		}
		/**
		* 处理一封新邮件（按 account 串行调用；内部 catch 掉业务错误并写状态，避免整批中断）。
		*/
		async process(account, provider, msg) {
			const fallbackOutcome = (messageId, status, skipped = false) => ({
				messageId,
				status,
				matchedRuleIds: [],
				deliveryCount: 0,
				skipped
			});
			const existing = getMessageByUid(account.id, msg.uid);
			if (existing && existing.status !== "ignored_no_keyword" && existing.status !== "ignored_type") {
				this.log.debug(`邮件 UID=${msg.uid} 已处理过（#${existing.id} ${existing.status}），跳过`);
				return fallbackOutcome(existing.id, existing.status, true);
			}
			const rules = listRules().filter((r) => r.enabled);
			const strategy = this.setting("multiRuleStrategy") === "priority" ? "priority" : "all";
			const hitRules = matchRules(rules, {
				subject: msg.subject,
				body: msg.bodyText
			}, strategy).map((h) => ({
				hit: h,
				rule: rules.find((r) => r.id === h.ruleId)
			})).filter((x) => !!x.rule);
			const rfcId = (msg.rfcMessageId || "").trim() || `uid:${account.uidValidity ?? ""}:${msg.uid}`;
			const up = upsertMessage({
				accountId: account.id,
				imapUid: msg.uid,
				rfcMessageId: msg.rfcMessageId || null,
				providerMessageId: rfcId,
				threadKey: msg.threadKey,
				subject: msg.subject,
				fromAddr: msg.fromAddr,
				fromName: msg.fromName,
				receivedAt: msg.receivedAt,
				status: "queued"
			});
			const messageId = up.id;
			if (hitRules.length === 0) {
				const fallbackEnabled = !!this.setting("defaultPathEnabled");
				const fallbackPath = String(this.setting("defaultPath") ?? "").trim();
				const allowed = fallbackEnabled && fallbackPath ? msg.parts.filter((p) => isAllowedAttachment(p.filename, p.mimeType, this.fallbackTypes(rules))) : [];
				if (allowed.length === 0) {
					updateMessageStatus(messageId, "ignored_no_keyword");
					updateMessageReplyStatus(messageId, "disabled", "未命中关键词，不自动回信");
					this.log.info(`未命中关键词：${msg.subject || "(无主题)"} → ignored_no_keyword`);
					this.emitRecord(messageId);
					return fallbackOutcome(messageId, "ignored_no_keyword");
				}
				this.log.info(`未命中关键词，但命中兜底路径：${fallbackPath}（${allowed.length} 个附件）`);
				const downloaded = await this.downloadAll(account, provider, messageId, msg, allowed);
				if (!downloaded) return fallbackOutcome(messageId, "failed");
				createDeliveries(downloaded.map((a) => ({
					messageId,
					attachmentId: a.attachmentId,
					targetId: 0,
					targetPath: fallbackPath,
					required: true
				})));
				updateMessageStatus(messageId, "queued");
				updateMessageReplyStatus(messageId, "disabled", "兜底路径不入回信流程");
				this.emitRecord(messageId);
				this.deps.emit({
					type: "delivery:changed",
					messageId
				});
				this.deps.emit({ type: "dashboard:changed" });
				this.deps.dispatcher.schedule();
				return {
					messageId,
					status: "queued",
					matchedRuleIds: [],
					deliveryCount: downloaded.length,
					skipped: false
				};
			}
			const allowedParts = msg.parts.filter((p) => hitRules.some(({ rule }) => isAllowedAttachment(p.filename, p.mimeType, rule.fileTypes)));
			if (allowedParts.length === 0) {
				updateMessageMatch(messageId, {
					matchedRuleId: hitRules[0].rule.id,
					matchedKeyword: hitRules[0].rule.keyword,
					matchSource: hitRules[0].hit.source
				});
				updateMessageStatus(messageId, "ignored_type");
				updateMessageReplyStatus(messageId, "disabled", "附件类型不在白名单，不自动回信");
				this.log.info(`命中规则但附件类型不符：${msg.subject}（附件 ${msg.parts.length} 个）→ ignored_type`);
				this.emitRecord(messageId);
				return fallbackOutcome(messageId, "ignored_type");
			}
			const downloaded = await this.downloadAll(account, provider, messageId, msg, allowedParts);
			if (!downloaded) {
				updateMessageReplyStatus(messageId, "disabled", "附件下载失败，不自动回信");
				this.emitRecord(messageId);
				return fallbackOutcome(messageId, "failed");
			}
			const items = [];
			for (const { rule } of hitRules) {
				const ruleAttachments = downloaded.filter((d) => isAllowedAttachment(d.part.filename, d.part.mimeType, rule.fileTypes));
				if (ruleAttachments.length === 0) continue;
				for (const target of rule.targets) {
					if (!target.enabled) continue;
					for (const att of ruleAttachments) items.push({
						messageId,
						attachmentId: att.attachmentId,
						targetId: target.id,
						targetPath: target.path,
						required: target.required
					});
				}
			}
			if (items.length === 0) {
				updateMessageStatus(messageId, "ignored_type", "命中的规则没有可用的目标文件夹");
				updateMessageReplyStatus(messageId, "disabled", "规则没有可用目标文件夹，不自动回信");
				this.emitRecord(messageId);
				return fallbackOutcome(messageId, "ignored_type");
			}
			createDeliveries(items);
			updateMessageMatch(messageId, {
				matchedRuleId: hitRules[0].rule.id,
				matchedKeyword: hitRules[0].rule.keyword,
				matchSource: hitRules[0].hit.source
			});
			if (up.inserted) for (const { rule } of hitRules) {
				const files = downloaded.filter((d) => isAllowedAttachment(d.part.filename, d.part.mimeType, rule.fileTypes)).length;
				hitIncrement(rule.id, {
					messages: 1,
					files
				});
			}
			updateMessageReplyStatus(messageId, this.initialReplyStatus(account, msg, hitRules.map((h) => h.rule)));
			updateMessageStatus(messageId, "queued");
			this.log.info(`命中 ${hitRules.map((h) => h.rule.keyword).join("、")}：邮件 #${messageId}，附件 ${downloaded.length} 个，投递 ${items.length} 条`);
			this.emitRecord(messageId);
			this.deps.emit({
				type: "delivery:changed",
				messageId
			});
			this.deps.emit({ type: "dashboard:changed" });
			this.deps.dispatcher.schedule();
			return {
				messageId,
				status: "queued",
				matchedRuleIds: hitRules.map((h) => h.rule.id),
				deliveryCount: items.length,
				skipped: false
			};
		}
		/** 下载（或复用已下载）附件；失败时把消息标记 failed 并返回 null */
		async downloadAll(account, provider, messageId, msg, parts) {
			const out = [];
			for (const part of parts) {
				const row = upsertAttachment(messageId, {
					partId: part.partId,
					filename: part.filename,
					mimeType: part.mimeType,
					declaredSize: part.size
				});
				if (row.status === "downloaded" && row.tmp_path && await pathExists(row.tmp_path)) {
					out.push({
						attachmentId: row.id,
						part
					});
					continue;
				}
				const safePart = sanitizeFilename(part.partId || "attachment", "attachment").replace(/[^\w.-]/g, "_");
				const dest = (0, node_path.join)(this.deps.tmpDir, `${account.id}-${account.uidValidity ?? "na"}-${msg.uid}-${safePart}.part`);
				try {
					const res = await provider.downloadAttachment(msg.uid, part, dest);
					setAttachmentDownloaded(row.id, {
						tmpPath: res.tmpPath || dest,
						size: res.size,
						sha256: res.sha256
					});
					out.push({
						attachmentId: row.id,
						part
					});
					this.log.info(`附件已下载：${part.filename}（${Math.round(res.size / 1024)}KB）`);
				} catch (e) {
					const message = e instanceof Error ? e.message : String(e);
					const code = e.code ?? "DOWNLOAD_FAILED";
					setAttachmentStatus(row.id, "failed", message);
					updateMessageStatus(messageId, "failed", `[${code}] ${message}`);
					this.log.error(`附件下载失败 #${messageId} ${part.filename} [${code}]`, message);
					this.deps.emit({
						type: "toast",
						level: "error",
						title: "附件下载失败，邮件未归档",
						body: `${part.filename}：${message}`
					});
					return null;
				}
			}
			return out;
		}
		fallbackTypes(rules) {
			const set = new Set(DEFAULT_FALLBACK_TYPES);
			for (const r of rules) for (const t of r.fileTypes) set.add(t);
			return [...set];
		}
		initialReplyStatus(account, msg, rules) {
			if (!this.setting("replyEnabled")) return "disabled";
			if (rules.every((r) => !r.autoReply)) return "disabled";
			if (msg.autoSubmitted) return "suppressed";
			return "pending";
		}
		emitRecord(messageId) {
			const record = getRecordById(messageId);
			if (record) this.deps.emit({
				type: "message:upserted",
				record
			});
		}
		/**
		* dispatcher 在所有 delivery 进入终态时回调：聚合最终状态 → 回信 → 通知。
		* 幂等（重复调用不会重复回信：reply-service 检查 thread_key）。
		*/
		async onDeliveriesSettled(messageId) {
			const msg = getMessage(messageId);
			if (!msg) return;
			const agg = deliveryAggregate(messageId);
			if (!agg.allTerminal) return;
			const next = agg.requiredFailed > 0 || agg.failed > 0 && agg.done === 0 ? "failed" : "done";
			if (msg.status !== next) updateMessageStatus(messageId, next, next === "failed" ? msg.error : null);
			if (next === "done") try {
				await this.deps.replyService.maybeReply(messageId);
			} catch (e) {
				this.log.warn(`回信流程异常 #${messageId}`, e instanceof Error ? e.message : String(e));
			}
			const record = getRecordById(messageId);
			if (record) this.deps.emit({
				type: "message:upserted",
				record
			});
			this.deps.emit({ type: "dashboard:changed" });
			const fileCount = new Set(record?.attachments.filter((a) => a.deliveries.some((d) => d.state === "done")).map((a) => a.id)).size;
			if (next === "done") {
				this.log.info(`归档完成 #${messageId}：${fileCount} 个文件`);
				this.deps.emit({
					type: "toast",
					level: "success",
					title: "图稿已归档",
					body: `${record?.fromName || record?.fromAddr || "客户"} · ${record?.matchedKeyword ?? ""} · ${fileCount} 个文件`
				});
			} else if (next === "failed") this.deps.emit({
				type: "toast",
				level: "error",
				title: "归档失败，需要人工处理",
				body: `${record?.subject ?? ""}：${record?.error ?? "存在失败的必达路径"}`
			});
			else if (agg.retryWait > 0 || agg.failed > 0) this.deps.emit({
				type: "toast",
				level: "warn",
				title: "部分路径未完成，正在重试",
				body: `${record?.subject ?? ""}`
			});
		}
	};
}));
// src/main/providers/errors.ts
/**
* 邮箱连接错误码与中文修复指引（ARCHITECTURE §2.3 的表）。
*
* 这是"非技术用户第一道坎"：错误码必须稳定、message 必须能直接照着修。
* 所有 mapping 都是纯函数，便于单测（不需要真实邮箱）。
*/
/** 从任意异常里提取一段可读的原始响应（截断 + 去换行，供 UI 折叠） */
function errDetail(err) {
	const e = err;
	const parts = [];
	const push = (v) => {
		if (typeof v === "string" && v.trim()) parts.push(v.trim());
	};
	push(e?.responseText);
	push(e?.response);
	push(e?.serverResponseCode);
	if (parts.length === 0 && err instanceof Error) push(err.message);
	return parts.join(" | ").replace(/\s+/g, " ").slice(0, 500);
}
function textOf(err) {
	const e = err;
	return [
		e?.message,
		e?.responseText,
		e?.response,
		e?.serverResponseCode,
		e?.code
	].filter((x) => typeof x === "string").join(" \n ");
}
function withPrefix(base, protocol) {
	if (base === "TIMEOUT" || base === "PORT_BLOCKED" || base === "UNKNOWN") return base;
	if (base === "UNREACHABLE") return protocol === "imap" ? "IMAP_UNREACHABLE" : "SMTP_UNREACHABLE";
	if (base === "TLS") return protocol === "imap" ? "IMAP_TLS_ERROR" : "SMTP_TLS_ERROR";
	return base;
}
/**
* 统一错误映射（imapflow / nodemailer / node net / tls 的混合异常）。
* 判定顺序：认证文案 → IMAP 关闭 → 发件人拒绝 → TLS → 网络 → 超时 → 未知。
*/
function classifyMailError(err, protocol) {
	const e = err;
	const text = textOf(err);
	const lower = text.toLowerCase();
	const code = typeof e?.code === "string" ? e.code : "";
	const responseCode = typeof e?.responseCode === "number" ? e.responseCode : void 0;
	const detail = errDetail(err);
	const make = (c, extra) => ({
		code: c,
		message: extra ?? FIX_HINTS[c],
		detail
	});
	if (/authenticationfailed|invalid credentials|login failed|authentication failed|badcredentials/i.test(text) || e?.authenticationFailed === true) {
		if (/application-specific password required|web login required|app password/i.test(lower)) return make("IMAP_APP_PASSWORD_REQUIRED");
		return make(protocol === "imap" ? "IMAP_AUTH_FAILED" : "SMTP_AUTH_FAILED");
	}
	if (/application-specific password required|web login required/i.test(lower)) return make("IMAP_APP_PASSWORD_REQUIRED");
	if (/imap access is disabled|imap.*(disabled|turned off)|imap.*not enabled|imap disabled/i.test(lower)) return make("IMAP_DISABLED");
	if (protocol === "smtp" && (responseCode === 535 || /535|5\.7\.8|authentication required/i.test(text))) return make("SMTP_AUTH_FAILED");
	if (protocol === "smtp" && (responseCode === 550 || responseCode === 553 || /sender( address)? rejected|5\.7\.1|not permitted to send/i.test(text))) return make("SMTP_SENDER_REJECTED");
	if (protocol === "smtp" && (responseCode === 421 || responseCode === 450 || responseCode === 451 || responseCode === 452 || /4\.7\.0|try again later/i.test(text))) return make("SMTP_TEMP_FAIL");
	if (e?.tlsFailed === true || TLS_CODES.has(code) || /certificate|self.signed|altname|wrong version number|ssl routines|tls/i.test(lower)) return make(withPrefix("TLS", protocol));
	if (code === "ECONNREFUSED") return make("PORT_BLOCKED");
	if (NETWORK_UNREACHABLE.has(code) || /enotfound|econnrefused|ehostunreach|enetunreach|getaddrinfo/i.test(lower)) return make(withPrefix("UNREACHABLE", protocol));
	if (TIMEOUT_CODES.has(code) || /timed? ?out|timeout/i.test(lower)) return make("TIMEOUT");
	return make("UNKNOWN", detail ? `${FIX_HINTS.UNKNOWN}（${detail}）` : FIX_HINTS.UNKNOWN);
}
/** 预检 TCP 连通性（5s），区分 DNS 失败 / 端口不通 / 超时 */
function probeTcp(host, port, timeoutMs = 5e3) {
	return new Promise((resolvePromise) => {
		const started = Date.now();
		const socket = (0, node_net.connect)({
			host,
			port
		});
		let settled = false;
		const finish = (ok, err) => {
			if (settled) return;
			settled = true;
			socket.removeAllListeners();
			socket.destroy();
			resolvePromise({
				ok,
				latencyMs: Date.now() - started,
				error: err
			});
		};
		socket.setTimeout(timeoutMs);
		socket.once("connect", () => finish(true));
		socket.once("timeout", () => finish(false, {
			code: "TIMEOUT",
			message: FIX_HINTS.TIMEOUT
		}));
		socket.once("error", (err) => {
			const classified = classifyMailError(err, "imap");
			finish(false, classified);
		});
	});
}
/** 供 provider 生成一行 TestResultLine（预检失败时直接返回） */
function preflightLine(protocol, host, port, probe) {
	if (probe.ok) return null;
	const code = withPrefix(probe.error?.code ?? "UNKNOWN", protocol);
	return {
		protocol,
		ok: false,
		latencyMs: probe.latencyMs,
		host,
		port,
		errorCode: code,
		message: FIX_HINTS[code] ?? probe.error?.message ?? FIX_HINTS.UNKNOWN
	};
}
var FIX_HINTS, TLS_CODES, NETWORK_UNREACHABLE, TIMEOUT_CODES;
var init_errors = __esmMin((() => {
	FIX_HINTS = {
		IMAP_AUTH_FAILED: "IMAP 登录被拒绝：请检查邮箱地址与应用专用密码 / 授权码是否复制完整（Gmail 为 16 位、无空格；QQ 是授权码不是登录密码）",
		IMAP_APP_PASSWORD_REQUIRED: "需要应用专用密码：请先开启两步验证，再到 Google 账号安全设置生成 16 位应用专用密码（不能填邮箱登录密码）",
		IMAP_DISABLED: "邮箱服务端未开启 IMAP：QQ 邮箱请到「设置 → 账户 → 开启 IMAP/SMTP 服务」；企业邮箱请联系管理员开启",
		IMAP_UNREACHABLE: "无法连接 IMAP 服务器：请检查网络、服务器地址与端口是否正确，以及防火墙 / 代理是否放行 993 出站",
		IMAP_TLS_ERROR: "IMAP 加密连接失败：请检查电脑系统时间是否准确、服务器证书是否过期；企业自建服务器可在账户里勾选「允许自签名证书」",
		SMTP_AUTH_FAILED: "SMTP 登录被拒绝：请检查 SMTP 用户名与密码 / 授权码，并确认邮箱已开启 SMTP 服务",
		SMTP_SENDER_REJECTED: "发件地址不被服务器允许：回信的发件人必须等于登录账号或其已验证别名，请检查账户邮箱是否填写正确",
		SMTP_TEMP_FAIL: "邮件服务器临时拒绝收信（4xx）：稍后会自动重试；若持续出现请联系邮箱服务商",
		SMTP_UNREACHABLE: "无法连接 SMTP 服务器：请检查网络与服务器地址/端口，企业网络常见 465/587 被拦截",
		SMTP_TLS_ERROR: "SMTP 加密连接失败：可尝试改用 465 端口 SSL（STARTTLS 被拦截时常见）或检查服务器证书",
		PORT_BLOCKED: "端口无法连接：可能被防火墙 / 运营商拦截，或服务器地址填错（IMAP 993；SMTP 465 或 587）",
		TIMEOUT: "连接超时：网络较慢或邮件服务器无响应，请稍后重试或换一个网络环境",
		UNKNOWN: "未知错误：请查看错误详情；如反复出现请联系技术支持"
	};
	TLS_CODES = /* @__PURE__ */ new Set([
		"CERT_HAS_EXPIRED",
		"CERT_NOT_YET_VALID",
		"CERT_UNTRUSTED",
		"DEPTH_ZERO_SELF_SIGNED_CERT",
		"SELF_SIGNED_CERT_IN_CHAIN",
		"UNABLE_TO_VERIFY_LEAF_CERT",
		"UNABLE_TO_GET_ISSUER_CERT",
		"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
		"ERR_TLS_CERT_ALTNAME_INVALID",
		"ERR_SSL_WRONG_VERSION_NUMBER",
		"ERR_SSL_TLSV1_ALERT",
		"EPROTO",
		"HOSTNAME_MISMATCH"
	]);
	NETWORK_UNREACHABLE = /* @__PURE__ */ new Set([
		"ENOTFOUND",
		"EAI_AGAIN",
		"EAI_FAIL",
		"EHOSTUNREACH",
		"ENETUNREACH",
		"ENETDOWN",
		"ECONNRESET",
		"EPIPE"
	]);
	TIMEOUT_CODES = /* @__PURE__ */ new Set([
		"ETIMEDOUT",
		"ESOCKETTIMEDOUT",
		"CONNECT_TIMEOUT",
		"GREETING_TIMEOUT",
		"UPGRADE_TIMEOUT",
		"ETIMEOUT",
		"TIMEOUT"
	]);
}));
// src/main/smtp.ts
/**
* SMTP 回信：模板渲染 + MIME 构造 + nodemailer 发送 + 错误码映射。
*
* 安全/合规要点（ARCHITECTURE §2.6）：
*  - From 必须是登录账号本身或已验证别名（Gmail/QQ 会 550/553 拒绝其它发件人）
*  - Subject / To / 显示名来自不可信邮件头 → 先剔除 CR/LF 防 SMTP 头注入
*  - 纯文本 UTF-8（base64 传输），不池化连接（低频发送，避免被风控）
*  - 只回发件人，不设 Cc/Bcc/Reply-To
*/
function formatLocalTime(at = Date.now()) {
	const d = new Date(at);
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** 构造模板变量；{文件名} 用「、」连接，{数量} 为文件个数 */
function buildReplyVars(input) {
	const filenames = (input.filenames ?? []).filter((f) => !!f);
	return {
		文件名: filenames.join("、"),
		数量: String(filenames.length),
		关键词: input.keyword ?? "",
		时间: formatLocalTime(input.sentAt ?? Date.now()),
		工厂名: input.factoryName || "MailHarbor"
	};
}
/** 渲染模板：只替换已知变量，未知占位符原样保留（便于用户发现拼写错误） */
function renderTemplate(template, vars) {
	if (!template) return "";
	return template.replace(/\{([^{}]+)\}/g, (match, key) => {
		const v = vars[key.trim()];
		return v === void 0 ? match : v;
	});
}
/**
* 按设置选择中/英文模板。
* replyLanguage='both' 时：主题用中文模板，正文 = 中文 + 空行 + 英文（一封双语信，避免发两封）。
*/
function composeReply(settings, vars, lang = settings.replyLanguage, fallbackSubject = "图稿已收到") {
	const zh = {
		subject: renderTemplate(settings.replySubjectZh, vars),
		body: renderTemplate(settings.replyBodyZh, vars)
	};
	const en = {
		subject: renderTemplate(settings.replySubjectEn, vars),
		body: renderTemplate(settings.replyBodyEn, vars)
	};
	let picked;
	if (lang === "zh") picked = zh;
	else if (lang === "en") picked = en;
	else picked = {
		subject: zh.subject || en.subject,
		body: [zh.body, en.body].filter(Boolean).join("\n\n")
	};
	return {
		subject: normalizeReplySubject(picked.subject || fallbackSubject || en.subject),
		body: picked.body || ""
	};
}
/** 剔除 CR/LF 与控制字符（防 SMTP 头注入），截断过长内容 */
function sanitizeHeader(value, maxLen = 400) {
	if (!value) return "";
	return value.replace(/[\r\n\t\u0000-\u001f\u007f]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, maxLen);
}
/** 回信主题：已带 Re:/答复:/回复: 则不重复加；CR/LF 清洗 */
function normalizeReplySubject(subject) {
	const s = sanitizeHeader(subject);
	if (!s) return "Re:";
	if (/^\s*(re|aw|sv|答复|回复)\s*[：:]/i.test(s)) return s;
	return `Re: ${s}`;
}
/** Message-ID 规范化：去 CR/LF 并补 <> */
function normalizeMessageId(id) {
	const s = sanitizeHeader(id, 320).replace(/[<>]/g, "");
	return s ? `<${s}>` : "";
}
/**
* References 链：去重、保序，最后追加原 Message-ID（RFC 5322 回信惯例）。
* IMAP 没有 threadId，thread_key 取根（第一项）或原 Message-ID。
*/
function buildReferences(originalReferences, inReplyTo) {
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	const push = (raw) => {
		const id = normalizeMessageId(raw);
		if (!id || seen.has(id)) return;
		seen.add(id);
		out.push(id);
	};
	for (const r of originalReferences ?? []) push(r);
	push(inReplyTo);
	return out;
}
function createSmtpTransport(cfg) {
	const timeout = cfg.timeoutMs ?? 1e4;
	const isSsl = cfg.secure === "ssl";
	return nodemailer.default.createTransport({
		host: cfg.host,
		port: cfg.port,
		secure: isSsl,
		requireTLS: cfg.secure === "starttls",
		ignoreTLS: cfg.secure === "none",
		auth: cfg.user ? {
			user: cfg.user,
			pass: cfg.pass
		} : void 0,
		pool: false,
		connectionTimeout: timeout,
		greetingTimeout: timeout,
		socketTimeout: Math.max(timeout, 3e4),
		tls: {
			rejectUnauthorized: !cfg.allowSelfSigned,
			servername: cfg.host
		}
	});
}
function mailOptionsFor(req) {
	const references = buildReferences(req.references, req.inReplyTo);
	return {
		from: {
			name: sanitizeHeader(req.from.name, 120),
			address: sanitizeHeader(req.from.address, 320)
		},
		to: {
			name: sanitizeHeader(req.to.name, 120),
			address: sanitizeHeader(req.to.address, 320)
		},
		subject: normalizeReplySubject(req.subject),
		text: req.body ?? "",
		inReplyTo: req.inReplyTo ? normalizeMessageId(req.inReplyTo) : void 0,
		references: references.length ? references : void 0,
		headers: {
			"Auto-Submitted": "auto-replied",
			"X-Mailer": "MailHarbor"
		}
	};
}
/** 真正发信：失败抛 ReplySendError（code 为稳定错误码） */
async function sendReply(cfg, req) {
	const transport = createSmtpTransport(cfg);
	try {
		const info = await transport.sendMail(mailOptionsFor(req));
		const accepted = (info.accepted ?? []).map((a) => typeof a === "string" ? a : a.address ?? "").filter((a) => !!a);
		return {
			providerMessageId: info.messageId ?? "",
			response: info.response ?? "",
			accepted
		};
	} catch (e) {
		const c = classifyMailError(e, "smtp");
		throw new ReplySendError(c.code, c.message, c.detail);
	} finally {
		try {
			transport.close();
		} catch {}
	}
}
/** SMTP 测试连接：TCP 预检 → EHLO/AUTH → QUIT */
async function testSmtpConnection(cfg) {
	const probe = await probeTcp(cfg.host, cfg.port, cfg.timeoutMs ?? 5e3);
	const pre = preflightLine("smtp", cfg.host, cfg.port, probe);
	if (pre) return pre;
	const started = Date.now();
	const transport = createSmtpTransport(cfg);
	try {
		await transport.verify();
		return {
			protocol: "smtp",
			ok: true,
			latencyMs: Date.now() - started,
			host: cfg.host,
			port: cfg.port,
			message: "SMTP 登录成功，可以发信"
		};
	} catch (e) {
		const c = classifyMailError(e, "smtp");
		return {
			protocol: "smtp",
			ok: false,
			latencyMs: Date.now() - started,
			host: cfg.host,
			port: cfg.port,
			errorCode: c.code,
			message: c.message
		};
	} finally {
		try {
			transport.close();
		} catch {}
	}
}
var ReplySendError;
var init_smtp = __esmMin((() => {
	init_errors();
	ReplySendError = class extends Error {
		code;
		detail;
		constructor(code, message, detail) {
			super(message);
			this.name = "ReplySendError";
			this.code = code;
			this.detail = detail;
		}
	};
}));
// src/main/reply-service.ts
/** 回信决策：先安全后业务。所有分支都有可读 reason（写日志用，不含密码） */
function decideReply(i) {
	if (i.replyStatus === "sent") return {
		action: "wait",
		reason: "该邮件已回过信"
	};
	if (i.replyStatus === "suppressed") return {
		action: "wait",
		reason: "该邮件已被抑制回信"
	};
	if (i.replyStatus === "disabled") return {
		action: "wait",
		reason: "回信已关闭（规则或全局开关）"
	};
	if (!i.globalEnabled) return {
		action: "wait",
		replyStatus: "disabled",
		reason: "设置中关闭了自动回信"
	};
	if (!i.autoReply) return {
		action: "wait",
		replyStatus: "disabled",
		reason: "该规则未开启自动回信"
	};
	if (i.autoSubmitted) return {
		action: "suppress",
		replyStatus: "suppressed",
		reason: "自动回复类邮件（Auto-Submitted），不再回信"
	};
	const from = (i.fromAddr ?? "").trim().toLowerCase();
	if (!from || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) return {
		action: "suppress",
		replyStatus: "suppressed",
		reason: "发件人地址无效，无法回信"
	};
	if (i.selfAddresses.map((a) => a.trim().toLowerCase()).includes(from)) return {
		action: "suppress",
		replyStatus: "suppressed",
		reason: "发件人就是本账户自己（避免循环回信）"
	};
	if (NOREPLY.test(from)) return {
		action: "suppress",
		replyStatus: "suppressed",
		reason: "系统退信 / no-reply 地址，不回信"
	};
	if (i.threadOnce !== false && i.alreadySentThread) return {
		action: "suppress",
		replyStatus: "suppressed",
		reason: "同一线程已经回过信"
	};
	if (!i.requiredAllDone) return {
		action: "wait",
		reason: "等待必达路径全部完成"
	};
	if ((i.hourlyCount ?? 0) >= (i.hourlyCap ?? 60)) return {
		action: "suppress",
		replyStatus: "suppressed",
		reason: `本小时回信已达上限（${i.hourlyCap ?? 60} 封），下小时自动恢复`
	};
	if (i.circuitOpen) return {
		action: "wait",
		reason: "连续发送失败熔断中（30 分钟）"
	};
	return {
		action: "send",
		reason: "全部必达路径成功，发送回信"
	};
}
var MIN_SEND_INTERVAL_MS, NOREPLY, sleep, ReplyService;
var init_reply_service = __esmMin((() => {
	init_repos();
	init_smtp();
	init_log();
	MIN_SEND_INTERVAL_MS = 2e3;
	NOREPLY = /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounce)/i;
	sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
	ReplyService = class {
		deps;
		log;
		inflight = /* @__PURE__ */ new Set();
		circuits = /* @__PURE__ */ new Map();
		lastSentAt = /* @__PURE__ */ new Map();
		disposed = false;
		constructor(deps) {
			this.deps = deps;
			this.log = deps.logger ?? createLogger("reply");
		}
		now() {
			return this.deps.now ? this.deps.now() : Date.now();
		}
		settings() {
			const keys = [
				"replyEnabled",
				"replyDelaySec",
				"replySubjectZh",
				"replyBodyZh",
				"replySubjectEn",
				"replyBodyEn",
				"replyLanguage",
				"replyThreadOnce",
				"replyHourlyCap",
				"factoryName",
				"logLevel"
			];
			const out = {};
			for (const k of keys) out[k] = this.deps.getSetting(k);
			return out;
		}
		dispose() {
			this.disposed = true;
			this.inflight.clear();
		}
		circuitOf(accountId) {
			const existing = this.circuits.get(accountId);
			if (existing) return existing;
			const fresh = {
				failures: 0,
				lastFailureAt: 0,
				openedAt: null
			};
			this.circuits.set(accountId, fresh);
			return fresh;
		}
		isCircuitOpen(accountId) {
			const st = this.circuitOf(accountId);
			if (!st.openedAt) return false;
			if (this.now() - st.openedAt >= 18e5) {
				st.openedAt = null;
				st.failures = 0;
				return false;
			}
			return true;
		}
		/**
		* 由 pipeline 在一封邮件的全部 delivery 进入终态后调用。
		* 幂等：已 sent/suppressed/disabled 的邮件直接返回。
		*/
		async maybeReply(messageId) {
			const msg = getMessage(messageId);
			if (!msg) return;
			if (msg.reply_status !== "pending") return;
			const account = getAccount(msg.account_id);
			if (!account) return;
			if (!account.enabled) {
				updateMessageReplyStatus(messageId, "disabled", "账户已停用，不回信");
				return;
			}
			const rule = msg.matched_rule_id ? getRule(msg.matched_rule_id) : null;
			const agg = deliveryAggregate(messageId);
			const threadKey = msg.thread_key ?? msg.rfc_message_id ?? `mid:${messageId}`;
			const settings = this.settings();
			const dailyCount = repliesTodayCount(account.id);
			const hourlyCount = repliesLastHourCount(account.id);
			const circuitOpen = this.isCircuitOpen(account.id);
			const alreadySentThread = hasSentThread(account.id, threadKey);
			const decision = decideReply({
				replyStatus: msg.reply_status,
				autoReply: rule ? rule.autoReply : true,
				globalEnabled: settings.replyEnabled !== false,
				requiredAllDone: agg.requiredAllDone,
				alreadySentThread,
				fromAddr: msg.from_addr ?? "",
				selfAddresses: [
					account.email,
					account.imapUser,
					account.smtpUser
				],
				autoSubmitted: false,
				dailyCount,
				hourlyCount,
				threadOnce: settings.replyThreadOnce !== false,
				hourlyCap: Number(settings.replyHourlyCap) || 60,
				circuitOpen
			});
			if (decision.action === "wait") {
				if (decision.replyStatus && decision.replyStatus !== msg.reply_status) {
					updateMessageReplyStatus(messageId, decision.replyStatus, decision.reason);
					this.emitRecord(messageId);
				}
				return;
			}
			if (decision.action === "suppress") {
				this.log.info(`回信抑制（邮件 #${messageId}）：${decision.reason}`);
				updateMessageReplyStatus(messageId, decision.replyStatus ?? "suppressed", decision.reason);
				insertReply({
					accountId: account.id,
					messageId,
					threadKey,
					toAddr: msg.from_addr ?? "",
					subject: msg.subject,
					status: "suppressed",
					error: decision.reason
				});
				this.emitRecord(messageId);
				return;
			}
			const guard = `${account.id}:${threadKey}`;
			if (this.inflight.has(guard)) return;
			this.inflight.add(guard);
			try {
				const delaySec = Math.min(Math.max(Number(settings.replyDelaySec) || 0, 0), 300);
				if (delaySec > 0) {
					this.log.info(`回信延迟 ${delaySec}s 后发送（邮件 #${messageId}）`);
					await sleep(delaySec * 1e3);
				}
				if (this.disposed) return;
				const latest = getMessage(messageId);
				if (!latest || latest.reply_status !== "pending") return;
				if (hasSentThread(account.id, threadKey)) {
					updateMessageReplyStatus(messageId, "suppressed", "同一线程已经回过信");
					this.emitRecord(messageId);
					return;
				}
				const last = this.lastSentAt.get(account.id) ?? 0;
				const wait = MIN_SEND_INTERVAL_MS - (this.now() - last);
				if (wait > 0) await sleep(wait);
				if (this.disposed) return;
				const secrets = this.deps.getSecrets(account.id);
				const cfg = {
					host: account.smtpHost,
					port: account.smtpPort,
					secure: account.smtpSecure,
					user: account.smtpUser,
					pass: secrets.smtpPass
				};
				const request = this.buildRequest(account, msg, settings);
				if (!request) {
					updateMessageReplyStatus(messageId, "suppressed", "找不到可回信的发件人地址");
					this.emitRecord(messageId);
					return;
				}
				try {
					const result = await (this.deps.send ?? sendReply)(cfg, request);
					this.lastSentAt.set(account.id, this.now());
					insertReply({
						accountId: account.id,
						messageId,
						threadKey,
						toAddr: request.to.address,
						subject: request.subject,
						bodyPreview: request.body.slice(0, 500),
						status: "sent",
						providerMessageId: result.providerMessageId,
						sentAt: this.now()
					});
					updateMessageReplyStatus(messageId, "sent");
					const st = this.circuitOf(account.id);
					st.failures = 0;
					st.openedAt = null;
					this.log.info(`回信已发送（邮件 #${messageId} → ${request.to.address}）`);
					this.emitRecord(messageId);
					this.deps.emit({
						type: "toast",
						level: "success",
						title: "已自动回信",
						body: `已回复 ${request.to.address}`
					});
				} catch (e) {
					this.onSendFailed(account, msg, threadKey, e);
				}
			} finally {
				this.inflight.delete(guard);
			}
		}
		buildRequest(account, msg, settings) {
			const toAddr = (msg.from_addr ?? "").trim();
			if (!toAddr) return null;
			const vars = buildReplyVars({
				filenames: (getRecordById(msg.id)?.attachments ?? []).filter((a) => a.deliveries.some((d) => d.state === "done")).map((a) => a.filename),
				keyword: msg.matched_keyword,
				sentAt: this.now(),
				factoryName: String(settings.factoryName || "").trim() || account.smtpFromName || account.displayName || account.email
			});
			const rendered = composeReply({
				replySubjectZh: String(settings.replySubjectZh ?? ""),
				replyBodyZh: String(settings.replyBodyZh ?? ""),
				replySubjectEn: String(settings.replySubjectEn ?? ""),
				replyBodyEn: String(settings.replyBodyEn ?? ""),
				replyLanguage: settings.replyLanguage
			}, vars);
			const body = rendered.body || `已收到您的图稿（${vars["数量"]} 个文件）：${vars["文件名"]}\n\n— MailHarbor`;
			const references = [];
			if (msg.thread_key && msg.thread_key !== msg.rfc_message_id) references.push(msg.thread_key);
			return {
				from: {
					address: account.email,
					name: account.smtpFromName || account.displayName || account.email
				},
				to: {
					address: toAddr,
					name: msg.from_name ?? ""
				},
				subject: rendered.subject,
				body,
				inReplyTo: msg.rfc_message_id,
				references
			};
		}
		onSendFailed(account, msg, threadKey, e) {
			const code = e instanceof ReplySendError ? e.code : "UNKNOWN";
			const message = e instanceof Error ? e.message : String(e);
			this.log.warn(`回信失败（邮件 #${msg.id}）[${code}]`, message);
			insertReply({
				accountId: account.id,
				messageId: msg.id,
				threadKey,
				toAddr: msg.from_addr ?? "",
				subject: msg.subject,
				status: "failed",
				error: `[${code}] ${message}`.slice(0, 1e3)
			});
			updateMessageReplyStatus(msg.id, "failed", `回信失败：[${code}] ${message}`.slice(0, 500));
			this.emitRecord(msg.id);
			if (code === "SMTP_AUTH_FAILED") {
				setAccountStatus(account.id, "auth_failed", {
					errorCode: code,
					error: message,
					checked: true
				});
				const fresh = getAccount(account.id);
				if (fresh) this.deps.emit({
					type: "account:changed",
					account: fresh
				});
				this.deps.emit({
					type: "toast",
					level: "error",
					title: "回信失败：邮箱需要重新设置密码",
					body: "SMTP 登录被拒绝，请到「邮箱账户」重新填写应用专用密码 / 授权码"
				});
				return;
			}
			const st = this.circuitOf(account.id);
			if (this.now() - st.lastFailureAt > 18e5) st.failures = 0;
			st.failures++;
			st.lastFailureAt = this.now();
			if (st.failures >= 3 && !st.openedAt) {
				st.openedAt = this.now();
				this.deps.emit({
					type: "toast",
					level: "warn",
					title: "自动回信已暂停 30 分钟",
					body: `连续 3 次发送失败（${code}），稍后自动恢复`
				});
			}
		}
		emitRecord(messageId) {
			const record = getRecordById(messageId);
			if (record) this.deps.emit({
				type: "message:upserted",
				record
			});
			this.deps.emit({ type: "dashboard:changed" });
		}
	};
}));
// src/main/providers/imap.ts
/**
* IMAP 收信 + SMTP 发信（imapflow / nodemailer，唯一 Provider 实现）。
*
* 关键约束（docs/ARCHITECTURE.md §2.4–2.7）：
*  - 每个账户一条长连接；只读（BODY.PEEK，不置已读 / 不删除 / 不移动）
*  - UIDVALIDITY 变化 → 丢弃 last_uid，全量重扫最近 7 天（Message-ID 去重兜底）
*  - 增量：UID SEARCH UID <lastUid+1>:*，按 UID 升序处理
*  - 附件元数据用 BODYSTRUCTURE 递归（最多 5 层），中文名走 file-writer.decodeFilename
*  - 附件下载流式写临时文件 + SHA-256，不做全量内存缓冲
*  - IDLE 心跳 5 分钟 NOOP；服务器不支持 IDLE 时降级 30s 轮询；断线指数退避重连
*/
function providerConfigFromAccount(account, secrets) {
	return {
		accountId: account.id,
		email: account.email,
		displayName: account.displayName,
		imapHost: account.imapHost,
		imapPort: account.imapPort,
		imapSecure: account.imapSecure,
		imapUser: account.imapUser,
		imapPass: secrets.imapPass,
		smtpHost: account.smtpHost,
		smtpPort: account.smtpPort,
		smtpSecure: account.smtpSecure,
		smtpUser: account.smtpUser,
		smtpPass: secrets.smtpPass,
		smtpFromName: account.smtpFromName
	};
}
function providerConfigFromInput(input) {
	const imapPass = input.password ?? "";
	return {
		email: input.email,
		displayName: input.displayName,
		imapHost: input.imapHost,
		imapPort: input.imapPort,
		imapSecure: input.imapSecure,
		imapUser: input.imapUser,
		imapPass,
		smtpHost: input.smtpHost,
		smtpPort: input.smtpPort,
		smtpSecure: input.smtpSecure,
		smtpUser: input.smtpUser || input.imapUser,
		smtpPass: input.smtpSameAsImap ? imapPass : input.smtpPassword ?? "",
		smtpFromName: input.smtpFromName
	};
}
function smtpConfigOf(cfg) {
	return {
		host: cfg.smtpHost,
		port: cfg.smtpPort,
		secure: cfg.smtpSecure,
		user: cfg.smtpUser,
		pass: cfg.smtpPass,
		allowSelfSigned: cfg.allowSelfSigned
	};
}
function imapOptionsOf(cfg, overrides = {}) {
	return {
		host: cfg.imapHost,
		port: cfg.imapPort,
		secure: cfg.imapSecure === "ssl",
		doSTARTTLS: cfg.imapSecure !== "none",
		auth: {
			user: cfg.imapUser,
			pass: cfg.imapPass
		},
		logger: false,
		tls: {
			rejectUnauthorized: !cfg.allowSelfSigned,
			servername: cfg.imapHost
		},
		connectionTimeout: 1e4,
		greetingTimeout: 1e4,
		socketTimeout: 6e4,
		disableAutoIdle: false,
		autoIdleDelay: 500,
		maxIdleTime: IDLE_RENEW_MS,
		...overrides
	};
}
/** 递归提取附件（最多 5 层，跳过 multipart 容器与 inline 图片） */
function extractAttachments(root, maxDepth = 5) {
	const out = [];
	const walk = (node, depth) => {
		if (!node || depth > maxDepth) return;
		const isContainer = node.type.startsWith("multipart/") || node.type === "message/rfc822";
		const rawName = node.dispositionParameters?.filename ?? node.parameters?.name;
		if ((node.disposition === "attachment" || !!rawName && node.disposition !== "inline") && !isContainer) {
			const decoded = decodeFilename(rawName) || `attachment-${out.length + 1}`;
			out.push({
				partId: node.part ?? String(out.length + 1),
				filename: decoded,
				mimeType: node.type ?? "application/octet-stream",
				size: node.size ?? 0,
				disposition: node.disposition
			});
			return;
		}
		for (const child of node.childNodes ?? []) walk(child, depth + 1);
	};
	walk(root, 0);
	return out;
}
/** 找到第一个匹配的叶子节点（正文 text/plain / text/html 用） */
function findBodyPart(root, type, maxDepth = 5) {
	const walk = (node, depth) => {
		if (!node || depth > maxDepth) return null;
		if (node.type === type && node.part) return node;
		for (const child of node.childNodes ?? []) {
			const hit = walk(child, depth + 1);
			if (hit) return hit;
		}
		return null;
	};
	return walk(root, 0);
}
/** 极简 HTML 转文本（不引入 DOM 依赖；只用于规则匹配的正文兜底） */
function htmlToText(html) {
	return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, "\"").replace(/&#39;/gi, "'").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
/** 解析 FETCH 返回的 header Buffer（支持折行） */
function parseHeaderBlock(buffer) {
	const map = /* @__PURE__ */ new Map();
	if (!buffer) return map;
	const text = typeof buffer === "string" ? buffer : buffer.toString("utf8");
	let lastKey = "";
	for (const line of text.split(/\r?\n/)) {
		if (/^\s/.test(line) && lastKey) {
			map.set(lastKey, `${map.get(lastKey) ?? ""} ${line.trim()}`);
			continue;
		}
		const idx = line.indexOf(":");
		if (idx <= 0) continue;
		lastKey = line.slice(0, idx).trim().toLowerCase();
		map.set(lastKey, line.slice(idx + 1).trim());
	}
	return map;
}
/** References 头拆成 Message-ID 数组（'<' 开头的行为准，兼容无尖括号写法） */
function parseReferences(value) {
	if (!value) return [];
	const brackets = value.match(/<[^<>]+>/g);
	if (brackets && brackets.length > 0) return brackets;
	return value.split(/\s+/).filter((s) => /@/.test(s)).map((s) => `<${s.replace(/[<>]/g, "")}>`);
}
/** 线程键：References 根 → 原 Message-ID → uid 兜底 */
function threadKeyOf(rfcMessageId, references, fallback) {
	const refs = references.filter(Boolean);
	if (refs.length > 0) return refs[0];
	const id = (rfcMessageId ?? "").trim();
	if (id) return id.startsWith("<") ? id : `<${id.replace(/[<>]/g, "")}>`;
	return fallback ?? "unknown-thread";
}
function asUidList(found) {
	return Array.isArray(found) ? found : [];
}
function toTime(v, fallback = Date.now()) {
	if (v instanceof Date) return v.getTime();
	if (typeof v === "string") {
		const t = Date.parse(v);
		if (!Number.isNaN(t)) return t;
	}
	return fallback;
}
function mapImapError(err) {
	return classifyMailError(err, "imap");
}
/**
* 测试 IMAP：TCP 预检（5s）→ TLS 握手 → LOGIN → SELECT INBOX(只读) → 读 UIDVALIDITY → LOGOUT
*/
async function testImapConnection(cfg, timeoutMs = 1e4) {
	const probe = await probeTcp(cfg.imapHost, cfg.imapPort, Math.min(5e3, timeoutMs));
	const pre = preflightLine("imap", cfg.imapHost, cfg.imapPort, probe);
	if (pre) return pre;
	const started = Date.now();
	let client = null;
	try {
		client = new imapflow.ImapFlow(imapOptionsOf(cfg, {
			connectionTimeout: timeoutMs,
			greetingTimeout: timeoutMs,
			socketTimeout: timeoutMs * 2,
			disableAutoIdle: true
		}));
		await client.connect();
		const lock = await client.getMailboxLock("INBOX", { readOnly: true });
		try {
			const mb = client.mailbox;
			const uidValidity = mb && typeof mb === "object" ? String(mb.uidValidity) : "";
			return {
				protocol: "imap",
				ok: true,
				latencyMs: Date.now() - started,
				host: cfg.imapHost,
				port: cfg.imapPort,
				message: `IMAP 登录成功，收件箱 ${mb && typeof mb === "object" ? mb.exists : 0} 封（UIDVALIDITY ${uidValidity || "-"}）`
			};
		} finally {
			lock.release();
		}
	} catch (e) {
		const c = mapImapError(e);
		return {
			protocol: "imap",
			ok: false,
			latencyMs: Date.now() - started,
			host: cfg.imapHost,
			port: cfg.imapPort,
			errorCode: c.code,
			message: c.message
		};
	} finally {
		if (client) try {
			await client.logout();
		} catch {
			try {
				client.close();
			} catch {}
		}
	}
}
/** 分别测试 IMAP 与 SMTP，任一步失败即给出错误码与中文修复指引 */
async function testConnection(cfg) {
	const [imap, smtp] = await Promise.all([testImapConnection(cfg).catch((e) => ({
		protocol: "imap",
		ok: false,
		latencyMs: 0,
		host: cfg.imapHost,
		port: cfg.imapPort,
		errorCode: "UNKNOWN",
		message: e instanceof Error ? e.message : String(e)
	})), testSmtpConnection(smtpConfigOf(cfg)).catch((e) => ({
		protocol: "smtp",
		ok: false,
		latencyMs: 0,
		host: cfg.smtpHost,
		port: cfg.smtpPort,
		errorCode: "UNKNOWN",
		message: e instanceof Error ? e.message : String(e)
	}))]);
	return {
		ok: imap.ok && smtp.ok,
		lines: [imap, smtp],
		testedAt: Date.now()
	};
}
var IDLE_HEARTBEAT_MS, IDLE_RENEW_MS, POLL_FALLBACK_MS, RECONNECT_DELAYS_MS, DOWNLOAD_TIMEOUT_MS, MAX_BODY_BYTES, ProviderError, ImapSmtpProvider;
var init_imap = __esmMin((() => {
	init_file_writer();
	init_log();
	init_errors();
	init_smtp();
	IDLE_HEARTBEAT_MS = 3e5;
	IDLE_RENEW_MS = 15e5;
	POLL_FALLBACK_MS = 3e4;
	RECONNECT_DELAYS_MS = [
		5e3,
		1e4,
		3e4,
		6e4,
		3e5
	];
	DOWNLOAD_TIMEOUT_MS = 18e4;
	MAX_BODY_BYTES = 524288;
	ProviderError = class extends Error {
		code;
		mailCode;
		constructor(code, message, mailCode) {
			super(message);
			this.name = "ProviderError";
			this.code = code;
			this.mailCode = mailCode;
		}
	};
	ImapSmtpProvider = class {
		cfg;
		log;
		opts;
		client = null;
		state = {
			uidValidity: null,
			uidNext: null,
			exists: 0,
			lastSeenUid: 0
		};
		connecting = null;
		idleRunning = false;
		idleOnMail = null;
		idleDebounce = null;
		heartbeatTimer = null;
		supervisorTimer = null;
		pollTimer = null;
		reconnectAttempts = 0;
		reconnecting = false;
		disposed = false;
		constructor(cfg, opts = {}) {
			this.cfg = cfg;
			this.opts = opts;
			this.log = opts.logger ?? createLogger(`imap:${cfg.email}`);
		}
		async connect() {
			if (this.connecting) return this.connecting;
			if (this.client && this.client.usable) return this.state;
			this.connecting = this.doConnect().finally(() => {
				this.connecting = null;
			});
			return this.connecting;
		}
		async doConnect() {
			await this.closeClient();
			const client = new imapflow.ImapFlow(imapOptionsOf(this.cfg));
			this.client = client;
			this.attachClientErrorHandlers(client);
			try {
				await client.connect();
				const mailbox = await client.mailboxOpen("INBOX", { readOnly: true });
				this.state = {
					uidValidity: mailbox ? String(mailbox.uidValidity) : null,
					uidNext: mailbox ? mailbox.uidNext : null,
					exists: mailbox ? mailbox.exists : 0,
					lastSeenUid: this.state.lastSeenUid
				};
				this.reconnectAttempts = 0;
				this.log.info(`IMAP 已连接（${this.cfg.imapHost}:${this.cfg.imapPort}），UIDVALIDITY=${this.state.uidValidity}`);
				this.opts.onStateChange?.({ connected: true });
				if (this.idleRunning) this.attachIdleHandlers();
				return this.state;
			} catch (e) {
				const c = mapImapError(e);
				this.log.warn(`IMAP 连接失败 [${c.code}]`, c.detail ?? c.message);
				this.opts.onStateChange?.({
					connected: false,
					errorCode: c.code,
					message: c.message
				});
				await this.closeClient();
				throw new ProviderError(c.code, c.message, c.code);
			}
		}
		attachClientErrorHandlers(client) {
			client.on("error", (err) => {
				if (this.disposed) return;
				const c = mapImapError(err);
				this.log.warn(`IMAP 连接异常 [${c.code}]`, c.detail ?? c.message);
				this.opts.onStateChange?.({
					connected: false,
					errorCode: c.code,
					message: c.message
				});
			});
			client.on("close", () => {
				if (this.disposed) return;
				this.log.info("IMAP 连接已断开（等待自动重连 / 下一次轮询）");
				this.opts.onStateChange?.({ connected: false });
			});
		}
		/** 取当前连接；必要时重连 */
		async ensureClient() {
			if (this.client && this.client.usable) return this.client;
			await this.connect();
			if (!this.client) throw new ProviderError("NO_CONNECTION", "IMAP 未连接");
			return this.client;
		}
		async closeClient() {
			const client = this.client;
			this.client = null;
			if (!client) return;
			try {
				client.removeAllListeners("exists");
				client.removeAllListeners("close");
				client.removeAllListeners("error");
			} catch {}
			try {
				if (client.usable) await client.logout();
				else client.close();
			} catch {
				try {
					client.close();
				} catch {}
			}
		}
		isConnected() {
			return !!this.client && this.client.usable;
		}
		isListening() {
			return this.idleRunning || !!this.pollTimer;
		}
		getSyncState() {
			return { ...this.state };
		}
		async fetchNewMessages(opts) {
			const client = await this.ensureClient();
			const sync = this.state;
			const max = Math.max(1, Math.min(opts.maxMessages ?? 25, 200));
			let uids = [];
			if (!!opts.uidValidity && !!sync.uidValidity && String(opts.uidValidity) !== String(sync.uidValidity)) {
				this.log.warn(`UIDVALIDITY 变化 ${opts.uidValidity} → ${sync.uidValidity}，改为全量重扫最近 7 天`);
				const since = /* @__PURE__ */ new Date(Date.now() - 6048e5);
				try {
					uids = asUidList(await client.search({ since }, { uid: true })).sort((a, b) => a - b);
				} catch {
					uids = [];
				}
				if (uids.length === 0) uids = asUidList(await client.search({ uid: "1:*" }, { uid: true })).sort((a, b) => a - b);
				uids = uids.slice(-max);
			} else {
				const from = Math.max(1, Math.floor(opts.lastUid) + 1);
				uids = asUidList(await client.search({ uid: `${from}:*` }, { uid: true })).filter((u) => u >= from && u > opts.lastUid).sort((a, b) => a - b);
				uids = uids.slice(0, max);
			}
			if (uids.length === 0) return [];
			const range = uids.join(",");
			const metas = await client.fetchAll(range, {
				uid: true,
				envelope: true,
				bodyStructure: true,
				internalDate: true,
				size: true,
				headers: [
					"auto-submitted",
					"references",
					"in-reply-to",
					"from"
				]
			});
			metas.sort((a, b) => a.uid - b.uid);
			const out = [];
			for (const meta of metas) try {
				out.push(await this.toInboundMessage(meta));
			} catch (e) {
				this.log.warn(`解析邮件 UID=${meta.uid} 失败`, e instanceof Error ? e.message : String(e));
			}
			if (out.length > 0) this.state.lastSeenUid = Math.max(this.state.lastSeenUid, out[out.length - 1].uid);
			return out;
		}
		async toInboundMessage(meta) {
			const envelope = meta.envelope ?? {};
			const headers = parseHeaderBlock(meta.headers);
			const references = parseReferences(headers.get("references"));
			const inReplyTo = headers.get("in-reply-to");
			if (inReplyTo) references.push(...parseReferences(inReplyTo));
			const rfcMessageId = (envelope.messageId ?? headers.get("message-id") ?? "").trim();
			const autoSubmitted = !!headers.get("auto-submitted") && !/^\s*no\s*$/i.test(headers.get("auto-submitted") ?? "");
			const from = envelope.from?.[0];
			const receivedAt = toTime(meta.internalDate ?? envelope.date);
			const bodyText = await this.readBodyText(meta);
			const parts = extractAttachments(meta.bodyStructure);
			return {
				uid: meta.uid,
				rfcMessageId,
				references,
				threadKey: threadKeyOf(rfcMessageId, references, `uid:${this.state.uidValidity ?? ""}:${meta.uid}`),
				subject: envelope.subject ?? "",
				fromAddr: from?.address ?? "",
				fromName: from?.name ?? "",
				receivedAt,
				bodyText,
				parts,
				autoSubmitted
			};
		}
		async readBodyText(meta) {
			const client = this.client;
			if (!client) return "";
			const plain = findBodyPart(meta.bodyStructure, "text/plain");
			const html = plain ? null : findBodyPart(meta.bodyStructure, "text/html");
			const part = plain ?? html;
			if (!part?.part) return "";
			try {
				const dl = await client.download(String(meta.uid), part.part, {
					uid: true,
					maxBytes: MAX_BODY_BYTES
				});
				if (!dl.content) return "";
				const chunks = [];
				let total = 0;
				for await (const chunk of dl.content) {
					const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
					chunks.push(buf);
					total += buf.length;
					if (total >= MAX_BODY_BYTES) break;
				}
				const text = Buffer.concat(chunks).toString("utf8");
				return part.type === "text/html" ? htmlToText(text) : text;
			} catch (e) {
				this.log.warn(`读取正文失败 UID=${meta.uid}`, e instanceof Error ? e.message : String(e));
				return "";
			}
		}
		async downloadAttachment(uid, part, destTmpPath) {
			const client = await this.ensureClient();
			await (0, node_fs_promises.mkdir)((0, node_path.dirname)(destTmpPath), { recursive: true });
			const dl = await client.download(String(uid), part.partId, { uid: true });
			if (!dl.content) throw new ProviderError("PART_NOT_FOUND", `附件不存在或已被删除：${part.filename}`, "UNKNOWN");
			const hash = (0, node_crypto.createHash)("sha256");
			let size = 0;
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				dl.content.destroy(/* @__PURE__ */ new Error("download timeout"));
			}, DOWNLOAD_TIMEOUT_MS);
			try {
				await (0, node_stream_promises.pipeline)(dl.content, new node_stream.Transform({ transform(chunk, _enc, cb) {
					size += chunk.length;
					hash.update(chunk);
					cb(null, chunk);
				} }), (0, node_fs.createWriteStream)(destTmpPath));
			} catch (e) {
				await (0, node_fs_promises.rm)(destTmpPath, { force: true }).catch(() => {});
				if (timedOut) throw new ProviderError("DOWNLOAD_TIMEOUT", "附件下载超时（180 秒），请检查网络后重试");
				if (e instanceof ProviderError) throw e;
				const msg = e instanceof Error ? e.message : String(e);
				if (/too large|maxBytes/i.test(msg)) throw new ProviderError("ATTACHMENT_TOO_LARGE", "附件超过单封大小限制");
				throw new ProviderError("DOWNLOAD_FAILED", `附件下载失败：${msg}`);
			} finally {
				clearTimeout(timer);
			}
			if (size === 0) {
				await (0, node_fs_promises.rm)(destTmpPath, { force: true }).catch(() => {});
				throw new ProviderError("EMPTY_ATTACHMENT", "下载到的附件为空（可能被服务器拒绝）");
			}
			return {
				size,
				sha256: hash.digest("hex"),
				tmpPath: destTmpPath
			};
		}
		async sendReply(req) {
			return sendReply(smtpConfigOf(this.cfg), req);
		}
		async testConnection() {
			return testConnection(this.cfg);
		}
		/**
		* 进入 IDLE 监听：服务器不支持 IDLE 时自动降级为 30s 轮询。
		* 断线由 supervisor 指数退避重连，重连成功后回调 onMail（scheduler 立即补扫）。
		*/
		async startIdle(onMail) {
			this.idleOnMail = onMail;
			this.idleRunning = true;
			await this.ensureClient();
			const client = this.client;
			if (!client) return;
			if (!client.capabilities.has("IDLE")) {
				this.log.info("服务器不支持 IDLE，降级为 30 秒轮询");
				this.startPolling(onMail, POLL_FALLBACK_MS);
				return;
			}
			this.attachIdleHandlers();
			this.heartbeatTimer = setInterval(() => void this.safeNoop(), IDLE_HEARTBEAT_MS);
			this.supervisorTimer = setInterval(() => void this.supervise(), 15e3);
			this.log.info("已进入 IMAP IDLE 监听（心跳 5 分钟）");
		}
		attachIdleHandlers() {
			const client = this.client;
			if (!client) return;
			client.removeAllListeners("exists");
			client.on("exists", () => {
				if (!this.idleRunning) return;
				if (this.idleDebounce) clearTimeout(this.idleDebounce);
				this.idleDebounce = setTimeout(() => {
					this.idleDebounce = null;
					try {
						this.idleOnMail?.();
					} catch (e) {
						this.log.warn("IDLE 新邮件回调异常", e instanceof Error ? e.message : String(e));
					}
				}, 500);
			});
		}
		async safeNoop() {
			const client = this.client;
			if (!client || !client.usable) return;
			try {
				await client.noop();
			} catch (e) {
				this.log.warn("IMAP NOOP 心跳失败，等待重连", e instanceof Error ? e.message : String(e));
				await this.closeClient();
			}
		}
		async supervise() {
			if (this.disposed || !this.idleRunning || this.reconnecting) return;
			if (this.isConnected()) return;
			this.reconnecting = true;
			try {
				const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)];
				this.reconnectAttempts++;
				this.log.info(`${Math.round(delay / 1e3)}s 后尝试重连 IMAP（第 ${this.reconnectAttempts} 次）`);
				await new Promise((r) => setTimeout(r, delay));
				if (this.disposed || !this.idleRunning) return;
				await this.connect();
				this.log.info("IMAP 重连成功，立即补扫离线期间的邮件");
				try {
					this.idleOnMail?.();
				} catch {}
			} catch (e) {
				this.log.warn("IMAP 重连失败", e instanceof Error ? e.message : String(e));
			} finally {
				this.reconnecting = false;
			}
		}
		startPolling(cb, intervalMs = POLL_FALLBACK_MS) {
			this.stopPolling();
			this.pollTimer = setInterval(() => {
				try {
					cb();
				} catch (e) {
					this.log.warn("轮询回调异常", e instanceof Error ? e.message : String(e));
				}
			}, intervalMs);
		}
		stopPolling() {
			if (this.pollTimer) clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		async stopIdle() {
			this.idleRunning = false;
			this.idleOnMail = null;
			if (this.idleDebounce) clearTimeout(this.idleDebounce);
			this.idleDebounce = null;
			if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
			if (this.supervisorTimer) clearInterval(this.supervisorTimer);
			this.heartbeatTimer = null;
			this.supervisorTimer = null;
			this.stopPolling();
			try {
				this.client?.removeAllListeners("exists");
			} catch {}
		}
		async disconnect() {
			this.disposed = true;
			await this.stopIdle();
			await this.closeClient();
		}
		/** 供测试重置 disposed 标记（生产不会调用） */
		resetDisposedForTests() {
			this.disposed = false;
		}
	};
})), SCHED_BACKOFF_MS, AUTH_RETRY_MS, TICK_MS, AUTH_CODES, Scheduler;
var init_scheduler = __esmMin((() => {
	init_repos();
	init_log();
	init_imap();
	init_errors();
	SCHED_BACKOFF_MS = [
		5e3,
		1e4,
		3e4,
		6e4,
		3e5
	];
	AUTH_RETRY_MS = 18e5;
	TICK_MS = 3e3;
	AUTH_CODES = /* @__PURE__ */ new Set([
		"IMAP_AUTH_FAILED",
		"IMAP_APP_PASSWORD_REQUIRED",
		"IMAP_DISABLED",
		"SMTP_AUTH_FAILED"
	]);
	Scheduler = class {
		deps;
		log;
		timer = null;
		workers = /* @__PURE__ */ new Map();
		started = false;
		paused = true;
		ticking = false;
		constructor(deps) {
			this.deps = deps;
			this.log = deps.logger ?? createLogger("scheduler");
		}
		now() {
			return this.deps.now ? this.deps.now() : Date.now();
		}
		pollIntervalMs() {
			const sec = Number(this.deps.getSetting("pollIntervalSec") ?? 30);
			return Math.max(15, Number.isFinite(sec) ? sec : 30) * 1e3;
		}
		startAll() {
			if (this.started) return;
			this.started = true;
			this.paused = false;
			this.syncWorkers();
			this.timer = setInterval(() => void this.tick(), TICK_MS);
			this.deps.emit({
				type: "listening:changed",
				listening: true
			});
			this.log.info("调度器已启动（监听中）");
			this.tick();
		}
		stopAll() {
			this.paused = true;
			this.started = false;
			if (this.timer) clearInterval(this.timer);
			this.timer = null;
			for (const worker of this.workers.values()) this.disposeWorker(worker);
			this.workers.clear();
			this.deps.emit({
				type: "listening:changed",
				listening: false
			});
			this.log.info("调度器已停止（所有 IMAP 连接已断开）");
		}
		pause() {
			if (this.paused) return;
			this.paused = true;
			for (const worker of this.workers.values()) {
				if (worker.provider) worker.provider.stopIdle();
				worker.idleStarted = false;
			}
			this.deps.emit({
				type: "listening:changed",
				listening: false
			});
			this.log.info("已暂停监听");
		}
		async resume() {
			if (!this.started) {
				this.startAll();
				return;
			}
			if (!this.paused) {
				await this.checkNow();
				return;
			}
			this.paused = false;
			for (const worker of this.workers.values()) {
				worker.nextAttemptAt = 0;
				worker.lastPollAt = 0;
			}
			this.deps.emit({
				type: "listening:changed",
				listening: true
			});
			this.log.info("已恢复监听");
			this.tick();
		}
		isListening() {
			return this.started && !this.paused;
		}
		/** 最近一次 tick 后，下一次任一账户被检查的时间 */
		nextCheckAt() {
			if (this.paused || this.workers.size === 0) return null;
			const interval = this.pollIntervalMs();
			let min = null;
			for (const worker of this.workers.values()) {
				const at = worker.busy ? this.now() : Math.max(worker.lastPollAt + interval, worker.nextAttemptAt || 0);
				if (min === null || at < min) min = at;
			}
			return min;
		}
		/** 立即检查所有账户（按钮「立即检查」/ 休眠恢复） */
		async checkNow() {
			if (!this.started) return;
			this.syncWorkers();
			const wasPaused = this.paused;
			const tasks = [];
			for (const worker of this.workers.values()) {
				worker.nextAttemptAt = 0;
				tasks.push(this.pollWorker(worker, true));
			}
			await Promise.all(tasks);
			if (wasPaused) for (const worker of this.workers.values()) {
				if (worker.provider) await worker.provider.stopIdle().catch(() => {});
				worker.idleStarted = false;
			}
			this.deps.emit({ type: "dashboard:changed" });
		}
		syncWorkers() {
			const accounts = listAccounts().filter((a) => a.enabled && a.status !== "disabled");
			const alive = new Set(accounts.map((a) => a.id));
			for (const [id, worker] of this.workers) if (!alive.has(id)) {
				this.disposeWorker(worker);
				this.workers.delete(id);
			}
			for (const account of accounts) if (!this.workers.has(account.id)) this.workers.set(account.id, {
				accountId: account.id,
				provider: null,
				signature: "",
				failures: 0,
				nextAttemptAt: 0,
				lastPollAt: 0,
				busy: false,
				idleStarted: false,
				missingPasswordLogged: false
			});
		}
		async disposeWorker(worker) {
			const provider = worker.provider;
			worker.provider = null;
			worker.idleStarted = false;
			if (provider) try {
				await provider.disconnect();
			} catch {}
		}
		async tick() {
			if (this.ticking || this.paused || !this.started) return;
			this.ticking = true;
			try {
				this.syncWorkers();
				const interval = this.pollIntervalMs();
				const at = this.now();
				const due = [];
				for (const worker of this.workers.values()) {
					if (worker.busy) continue;
					if (worker.nextAttemptAt > at) continue;
					if (at - worker.lastPollAt < interval) continue;
					due.push(this.pollWorker(worker));
				}
				if (due.length > 0) {
					await Promise.all(due);
					this.deps.emit({ type: "dashboard:changed" });
				}
			} finally {
				this.ticking = false;
			}
		}
		/** IDLE 收到新邮件：尽快轮询该账户（≤3s），但不会打断正在进行的 poll */
		onIdleMail(worker) {
			if (this.paused) return;
			worker.lastPollAt = 0;
			if (!worker.busy) this.pollWorker(worker);
		}
		createProviderFor(account) {
			const cfg = providerConfigFromAccount(account, getAccountSecrets(account.id));
			if (this.deps.createProvider) return this.deps.createProvider(account, cfg);
			return new ImapSmtpProvider(cfg, {
				logger: createLogger(`imap:${account.email}`),
				onStateChange: (s) => {
					const current = getAccountRow(account.id);
					if (!current) return;
					if (s.connected) {
						if (current.status !== "enabled") this.applyStatus(account.id, "enabled", { ok: true });
					} else if (s.errorCode) {
						const status = AUTH_CODES.has(s.errorCode) ? "auth_failed" : "offline";
						this.applyStatus(account.id, status, {
							errorCode: s.errorCode,
							error: s.message ?? FIX_HINTS[s.errorCode]
						});
						if (status === "auth_failed") this.notifyAuthFailed(account);
					}
				}
			});
		}
		async getProvider(worker, account) {
			const signature = `${account.id}:${account.updatedAt}:${account.imapHost}:${account.imapPort}:${account.imapUser}:${account.hasPassword}`;
			if (worker.provider && worker.signature === signature) return worker.provider;
			if (worker.provider) await this.disposeWorker(worker);
			if (!account.hasPassword) {
				if (!worker.missingPasswordLogged) {
					this.log.warn(`账户 #${account.id} 未保存密码，跳过收信`);
					worker.missingPasswordLogged = true;
				}
				return null;
			}
			worker.provider = this.createProviderFor(account);
			worker.signature = signature;
			return worker.provider;
		}
		applyStatus(accountId, status, opts = {}) {
			const before = getAccountRow(accountId);
			setAccountStatus(accountId, status, {
				checked: true,
				...opts
			});
			const after = getAccount(accountId);
			if (after && (!before || before.status !== status || opts.errorCode)) this.deps.emit({
				type: "account:changed",
				account: after
			});
		}
		notifyAuthFailed(account) {
			this.deps.emit({
				type: "toast",
				level: "error",
				title: "邮箱需要重新设置密码",
				body: `${account.email} 登录被拒绝，请检查应用专用密码 / 授权码或 IMAP 服务是否开启`
			});
		}
		backoffMs(failures) {
			const idx = Math.min(Math.max(failures - 1, 0), SCHED_BACKOFF_MS.length - 1);
			return SCHED_BACKOFF_MS[idx];
		}
		/**
		* 单账户一轮：连接 → 增量拉取 → 逐封处理 → 更新游标/状态 → 首次成功后进入 IDLE。
		* 单账户串行（worker.busy 防重入）。
		*/
		async pollWorker(worker, force = false) {
			if (worker.busy) return;
			if (this.paused && !force) return;
			worker.busy = true;
			const accountId = worker.accountId;
			try {
				const account = getAccount(accountId);
				if (!account || !account.enabled || account.status === "disabled") {
					await this.disposeWorker(worker);
					return;
				}
				const provider = await this.getProvider(worker, account);
				if (!provider) {
					worker.lastPollAt = this.now();
					worker.nextAttemptAt = this.now() + 3e5;
					return;
				}
				const sync = await provider.connect();
				if (account.status !== "enabled") this.applyStatus(accountId, "enabled", { ok: true });
				else updateAccountSyncState(accountId, { lastOkAt: this.now() });
				const messages = await provider.fetchNewMessages({
					lastUid: account.lastUid,
					uidValidity: account.uidValidity,
					maxMessages: 25
				});
				let lastUid = account.lastUid;
				for (const msg of messages) {
					try {
						await this.deps.pipeline.process(getAccount(accountId) ?? account, provider, msg);
					} catch (e) {
						this.log.error(`处理邮件失败 UID=${msg.uid}`, e instanceof Error ? e.message : String(e));
					}
					if (msg.uid > lastUid) {
						lastUid = msg.uid;
						updateAccountSyncState(accountId, {
							lastUid,
							uidValidity: sync.uidValidity,
							lastCheckAt: this.now(),
							lastOkAt: this.now()
						});
					}
				}
				if (messages.length === 0) updateAccountSyncState(accountId, {
					uidValidity: sync.uidValidity,
					lastCheckAt: this.now(),
					lastOkAt: this.now()
				});
				worker.failures = 0;
				worker.nextAttemptAt = 0;
				worker.lastPollAt = this.now();
				if (!worker.idleStarted && this.isListening()) {
					worker.idleStarted = true;
					provider.startIdle(() => this.onIdleMail(worker)).catch((e) => {
						worker.idleStarted = false;
						this.log.warn("进入 IDLE 失败，继续兜底轮询", e instanceof Error ? e.message : String(e));
					});
				}
			} catch (e) {
				const classified = e instanceof ProviderError ? {
					code: e.mailCode ?? "UNKNOWN",
					message: e.message,
					detail: void 0
				} : classifyMailError(e, "imap");
				const auth = AUTH_CODES.has(classified.code);
				const status = auth ? "auth_failed" : "offline";
				this.applyStatus(accountId, status, {
					errorCode: classified.code,
					error: classified.message
				});
				worker.failures++;
				worker.lastPollAt = this.now();
				worker.nextAttemptAt = this.now() + (auth ? AUTH_RETRY_MS : this.backoffMs(worker.failures));
				this.log.warn(`账户 #${accountId} 收信失败 [${classified.code}]，${auth ? "30 分钟" : `${Math.round(this.backoffMs(worker.failures) / 1e3)}s`}后重试`, classified.detail ?? classified.message);
				if (auth) {
					const fresh = getAccount(accountId);
					if (fresh) this.notifyAuthFailed(fresh);
					worker.nextAttemptAt = this.now() + AUTH_RETRY_MS;
				}
				await this.disposeWorker(worker);
			} finally {
				worker.busy = false;
			}
		}
	};
}));
// src/main/backend-core.ts
function failedTest(message, protocol = "imap", input) {
	return {
		ok: false,
		lines: [{
			protocol: "imap",
			ok: false,
			latencyMs: 0,
			host: input?.imapHost ?? "",
			port: input?.imapPort ?? 0,
			errorCode: "UNKNOWN",
			message: protocol === "imap" ? message : "跳过 IMAP 测试"
		}, {
			protocol: "smtp",
			ok: false,
			latencyMs: 0,
			host: input?.smtpHost ?? "",
			port: input?.smtpPort ?? 0,
			errorCode: "UNKNOWN",
			message: protocol === "smtp" ? message : "跳过 SMTP 测试"
		}],
		testedAt: Date.now()
	};
}
function createBackendWith(deps) {
	const emit = (e) => {
		try {
			deps.bus.emit("event", e);
		} catch {}
	};
	const now = deps.now ?? (() => Date.now());
	/** 账户状态变化后推给 UI（列表/概览都靠它刷新） */
	const emitAccountChanged = (id) => {
		try {
			const acc = getAccount(id);
			if (acc) emit({
				type: "account:changed",
				account: acc
			});
		} catch {}
	};
	configureRepos({
		db: deps.db,
		codec: deps.codec
	});
	try {
		setLogLevel(String(deps.getSetting("logLevel") ?? "info"));
	} catch {}
	(0, node_fs.mkdirSync)(deps.tmpDir, { recursive: true });
	const dispatcher = new Dispatcher({
		emit,
		getSetting: deps.getSetting,
		tmpDir: deps.tmpDir,
		now
	});
	const replyService = new ReplyService({
		emit,
		getSetting: deps.getSetting,
		getSecrets: (id) => getAccountSecrets(id),
		now,
		send: deps.sendReply ?? sendReply
	});
	const pipeline = new MailPipeline({
		emit,
		getSetting: deps.getSetting,
		dispatcher,
		replyService,
		tmpDir: deps.tmpDir,
		now
	});
	dispatcher.onSettled = (messageId) => pipeline.onDeliveriesSettled(messageId);
	const scheduler = new Scheduler({
		emit,
		getSetting: deps.getSetting,
		pipeline: { process: (account, provider, msg) => pipeline.process(account, provider, msg) },
		now,
		createProvider: deps.createProvider
	});
	let disposed = false;
	return {
		bus: deps.bus,
		scheduler: {
			startAll: () => scheduler.startAll(),
			stopAll: () => scheduler.stopAll(),
			pause: () => scheduler.pause(),
			resume: async () => {
				await scheduler.resume();
				emit({ type: "dashboard:changed" });
			},
			isListening: () => scheduler.isListening(),
			checkNow: async () => {
				await scheduler.checkNow();
			},
			nextCheckAt: () => scheduler.nextCheckAt()
		},
		async testAccount(input) {
			if (!input?.password) return failedTest("请填写应用专用密码 / 授权码后再测试连接", "imap", input);
			if (!input.smtpSameAsImap && !input.smtpPassword) return failedTest("请填写 SMTP 密码（未勾选「与收件使用同一密码」时必填）", "smtp", input);
			try {
				return await testConnection(providerConfigFromInput(input));
			} catch (e) {
				return failedTest(`测试连接失败：${e instanceof Error ? e.message : String(e)}`, "imap", input);
			}
		},
		async testSavedAccount(id) {
			const account = getAccount(id);
			if (!account) throw new Error("账户不存在或已被删除");
			if (!account.hasPassword) {
				setAccountStatus(id, "auth_failed", {
					errorCode: "PASSWORD_MISSING",
					error: "尚未保存密码"
				});
				emitAccountChanged(id);
				return failedTest("该账户尚未保存密码，请编辑账户重新填写", "imap");
			}
			const cfg = providerConfigFromAccount(account, getAccountSecrets(id));
			let result;
			try {
				result = await testConnection(cfg);
			} catch (e) {
				result = failedTest(`测试连接失败：${e instanceof Error ? e.message : String(e)}`, "imap");
			}
			const errLine = result.lines.find((l) => !l.ok);
			if (result.ok) setAccountStatus(id, account.enabled ? "enabled" : "pending_test", {
				checked: true,
				ok: true,
				errorCode: null,
				error: null
			});
			else setAccountStatus(id, errLine?.errorCode === "IMAP_AUTH_FAILED" || errLine?.errorCode === "SMTP_AUTH_FAILED" ? "auth_failed" : "conn_failed", {
				checked: true,
				ok: false,
				errorCode: errLine?.errorCode ?? "UNKNOWN",
				error: errLine?.message ?? "测试连接失败"
			});
			emitAccountChanged(id);
			return result;
		},
		async testReply(to) {
			const target = (to ?? "").trim();
			if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(target)) return {
				ok: false,
				message: "收件邮箱格式不正确"
			};
			const account = listAccounts().filter((a) => a.enabled && a.hasPassword)[0];
			if (!account) return {
				ok: false,
				message: "没有已启用且配置了密码的账户，请先在「邮箱账户」里添加并测试通过"
			};
			const cfg = providerConfigFromAccount(account, getAccountSecrets(account.id));
			const smtpCfg = {
				host: cfg.smtpHost,
				port: cfg.smtpPort,
				secure: cfg.smtpSecure,
				user: cfg.smtpUser,
				pass: cfg.smtpPass
			};
			const settings = deps.getSetting;
			const lang = String(settings("replyLanguage") ?? "en");
			const subjectTpl = String(lang === "zh" ? settings("replySubjectZh") : settings("replySubjectEn"));
			const bodyTpl = String(lang === "zh" ? settings("replyBodyZh") : settings("replyBodyEn"));
			const vars = buildReplyVars({
				filenames: ["POD_ORDER_TEST.zip", "设计图_测试.tif"],
				keyword: "原图+卡套",
				sentAt: Date.now(),
				factoryName: account.smtpFromName || "MailHarbor"
			});
			try {
				const res = await (deps.sendReply ?? sendReply)(smtpCfg, {
					from: {
						name: account.smtpFromName || "MailHarbor",
						address: account.email
					},
					to: { address: target },
					subject: renderTemplate(subjectTpl, vars),
					body: renderTemplate(bodyTpl, vars)
				});
				emit({
					type: "toast",
					level: "success",
					title: "测试信已发送",
					body: `收件人 ${target}`
				});
				return {
					ok: true,
					message: `测试信已发送到 ${target}`,
					providerMessageId: res.providerMessageId
				};
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				emit({
					type: "toast",
					level: "error",
					title: "测试信发送失败",
					body: msg
				});
				return {
					ok: false,
					message: msg
				};
			}
		},
		async reconcile() {
			const r = await dispatcher.reconcile();
			if (r.adopted + r.reset + r.tmpCleaned > 0) {
				emit({ type: "dashboard:changed" });
				emit({
					type: "toast",
					level: "success",
					title: "启动对账完成",
					body: `认领 ${r.adopted} · 重做 ${r.reset} · 清理临时文件 ${r.tmpCleaned}`
				});
			}
		},
		async retryMessage(messageId, deliveryId) {
			await dispatcher.retryDelivery(messageId, deliveryId);
		},
		async init() {
			dispatcher.start();
			emit({ type: "dashboard:changed" });
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			scheduler.stopAll();
			dispatcher.stop();
			replyService.dispose();
		}
	};
}
var init_backend_core = __esmMin((() => {
	init_repos();
	init_dispatcher();
	init_pipeline();
	init_reply_service();
	init_scheduler();
	init_imap();
	init_smtp();
	init_log();
}));
// src/main/backend-impl.ts
var backend_impl_exports = /* @__PURE__ */ __exportAll({ createBackendImpl: () => createBackendImpl });
function createBackendImpl(ctx) {
	return createBackendWith({
		db: openDb(),
		bus: ctx.bus,
		codec: {
			encrypt: encryptSecret,
			decrypt: decryptSecret
		},
		getSetting,
		tmpDir: (0, node_path.join)(electron.app.getPath("temp"), "mailharbor")
	});
}
var init_backend_impl = __esmMin((() => {
	init_db();
	init_backend_core();
}));
// src/main/backend.ts
/**
* 后端装配入口：把 repos / providers / scheduler / pipeline / dispatcher / reply 组装起来。
* 该文件由 Lead 与 backend teammate 共同维护（契约见 services.ts）。
*/
function createBackend(opts) {
	const bus = new node_events.EventEmitter();
	bus.on("event", (e) => opts.onEvent(e));
	const { createBackendImpl } = (init_backend_impl(), __toCommonJS(backend_impl_exports));
	return createBackendImpl({ bus });
}
// src/main/index.ts
/**
* MailHarbor 主进程入口：
* 单实例锁 → 打开数据库 → 建窗口/托盘 → 注册 IPC → 启动 IMAP 调度（后台自动收信）。
*/
init_db();
var isDev = !electron.app.isPackaged;
var mainWindow = null;
var tray = null;
var backend = null;
var quitting = false;
if (!electron.app.requestSingleInstanceLock()) electron.app.quit();
else {
	electron.app.on("second-instance", () => showWindow());
	bootstrap();
}
function broadcast(e) {
	if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("main:event", e);
}
async function bootstrap() {
	await electron.app.whenReady();
	globalThis.__mhStartedAt = Date.now();
	openDb();
	electron.app.setAppUserModelId("com.mailharbor.app");
	backend = createBackend({ onEvent: (e) => {
		broadcast(e);
		if (e.type === "toast" && e.level !== "success") refreshTray();
		if (e.type === "account:changed" || e.type === "dashboard:changed") refreshTray();
	} });
	try {
		await backend.init();
	} catch (e) {
		console.error("[main] backend init failed:", e);
	}
	registerIpc({
		getBackend: () => backend,
		getWindow: () => mainWindow,
		broadcast
	});
	registerAppEvents();
	await createWindow();
	createTray();
	startAutostartArgs();
	try {
		await backend.scheduler.startAll();
		await backend.reconcile();
	} catch (e) {
		console.error("[main] scheduler start failed:", e);
	}
	electron.powerMonitor.on("resume", () => {
		backend?.scheduler.checkNow();
	});
	electron.powerMonitor.on("unlock-screen", () => {
		backend?.scheduler.checkNow();
	});
}
function startAutostartArgs() {
	if (process.argv.includes("--autostart")) setTimeout(() => mainWindow?.hide(), 800);
}
function registerAppEvents() {
	electron.app.on("window-all-closed", () => {
		if (quitting) electron.app.quit();
	});
	electron.app.on("before-quit", () => {
		quitting = true;
		try {
			backend?.scheduler.stopAll();
			backend?.dispose();
			disposeIpc();
			closeDb();
		} catch (e) {
			console.error("[main] shutdown error:", e);
		}
	});
	electron.app.on("activate", () => showWindow());
}
async function createWindow() {
	mainWindow = new electron.BrowserWindow({
		width: 1440,
		height: 900,
		minWidth: 1280,
		minHeight: 780,
		show: false,
		title: "MailHarbor",
		backgroundColor: "#FAF7F0",
		autoHideMenuBar: true,
		webPreferences: {
			preload: (0, node_path.join)(__dirname, "../preload/index.js"),
			contextIsolation: true,
			sandbox: false,
			nodeIntegration: false,
			webSecurity: true
		}
	});
	mainWindow.once("ready-to-show", () => {
		if (!process.argv.includes("--autostart")) mainWindow?.show();
	});
	mainWindow.on("close", (e) => {
		if (!quitting) {
			e.preventDefault();
			mainWindow?.hide();
		}
	});
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		electron.shell.openExternal(url);
		return { action: "deny" };
	});
	if (isDev && process.env.ELECTRON_RENDERER_URL) await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
	else await mainWindow.loadFile((0, node_path.join)(__dirname, "../renderer/index.html"));
}
function showWindow() {
	if (!mainWindow) return;
	if (mainWindow.isMinimized()) mainWindow.restore();
	mainWindow.show();
	mainWindow.focus();
}
function createTray() {
	const iconPath = resolveTrayIcon();
	const img = iconPath ? electron.nativeImage.createFromPath(iconPath) : electron.nativeImage.createEmpty();
	tray = new electron.Tray(img.isEmpty() ? electron.nativeImage.createEmpty() : img);
	tray.setToolTip("MailHarbor · 邮件收货助手");
	tray.on("double-click", () => showWindow());
	tray.on("click", () => showWindow());
	refreshTray();
}
function refreshTray() {
	if (!tray) return;
	const d = safeDashboard();
	const listening = d?.listening ?? false;
	const menu = electron.Menu.buildFromTemplate([
		{
			label: listening ? "● 监听中" : "○ 已暂停",
			enabled: false
		},
		{
			label: `今日收件 ${d?.todayMessages ?? 0} 封 · 待重试 ${d?.pendingRetry ?? 0}`,
			enabled: false
		},
		{ type: "separator" },
		{
			label: "打开主界面",
			click: () => showWindow()
		},
		{
			label: listening ? "暂停监听" : "恢复监听",
			click: async () => {
				if (!backend) return;
				if (backend.scheduler.isListening()) backend.scheduler.pause();
				else await backend.scheduler.resume();
				refreshTray();
			}
		},
		{
			label: "立即检查新邮件",
			click: () => void backend?.scheduler.checkNow()
		},
		{
			label: "打开存储文件夹",
			click: () => {
				const first = d?.disks?.[0]?.path;
				if (first) electron.shell.openPath(first);
			}
		},
		{ type: "separator" },
		{
			label: "退出 MailHarbor",
			click: () => {
				quitting = true;
				electron.app.quit();
			}
		}
	]);
	tray.setContextMenu(menu);
}
function safeDashboard() {
	try {
		return buildDashboard();
	} catch {
		return null;
	}
}
function resolveTrayIcon() {
	return [
		(0, node_path.join)(process.resourcesPath ?? "", "resources", "tray.png"),
		(0, node_path.join)(__dirname, "../../resources/tray.png"),
		(0, node_path.join)(electron.app.getAppPath(), "resources/tray.png")
	].find((p) => (0, node_fs.existsSync)(p)) ?? null;
}
