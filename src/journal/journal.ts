import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export interface JournalEntry<T = unknown> {
	result: T;
	tokens: number | null;
	hitCount: number;
	createdAt: number;
}

export interface JournalWriteInput<T = unknown> {
	result: T;
	tokens?: number | null;
}

export interface HumanJournalEntry<T = unknown> {
	response: T;
	resolvedAt: number;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS journal (
	cache_key TEXT PRIMARY KEY,
	result TEXT NOT NULL,
	tokens INTEGER,
	created_at INTEGER NOT NULL,
	hit_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS journal_human (
	cache_key TEXT PRIMARY KEY,
	response TEXT NOT NULL,
	resolved_at INTEGER NOT NULL
);
`;

export class Journal {
	private readonly db: Database.Database;

	constructor(dbPath: string) {
		const dir = dirname(dbPath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("synchronous = NORMAL");
		this.db.exec(SCHEMA_SQL);
	}

	close(): void {
		this.db.close();
	}

	lookup<T = unknown>(cacheKey: string): JournalEntry<T> | null {
		const row = this.db
			.prepare("SELECT result, tokens, created_at, hit_count FROM journal WHERE cache_key = ?")
			.get(cacheKey) as JournalRow | undefined;
		if (!row) return null;

		this.db.prepare("UPDATE journal SET hit_count = hit_count + 1 WHERE cache_key = ?").run(cacheKey);
		return {
			result: JSON.parse(row.result) as T,
			tokens: row.tokens,
			createdAt: row.created_at,
			hitCount: row.hit_count + 1,
		};
	}

	write<T = unknown>(cacheKey: string, input: JournalWriteInput<T>): void {
		this.db
			.prepare(
				`INSERT OR REPLACE INTO journal (cache_key, result, tokens, created_at, hit_count)
				 VALUES (?, ?, ?, ?, COALESCE((SELECT hit_count FROM journal WHERE cache_key = ?), 0))`,
			)
			.run(cacheKey, JSON.stringify(input.result), input.tokens ?? null, Date.now(), cacheKey);
	}

	lookupHuman<T = unknown>(cacheKey: string): HumanJournalEntry<T> | null {
		const row = this.db.prepare("SELECT response, resolved_at FROM journal_human WHERE cache_key = ?").get(cacheKey) as
			| HumanJournalRow
			| undefined;
		if (!row) return null;
		return {
			response: JSON.parse(row.response) as T,
			resolvedAt: row.resolved_at,
		};
	}

	writeHuman<T = unknown>(cacheKey: string, response: T): void {
		this.db
			.prepare("INSERT OR REPLACE INTO journal_human (cache_key, response, resolved_at) VALUES (?, ?, ?)")
			.run(cacheKey, JSON.stringify(response), Date.now());
	}
}

interface JournalRow {
	result: string;
	tokens: number | null;
	created_at: number;
	hit_count: number;
}

interface HumanJournalRow {
	response: string;
	resolved_at: number;
}
