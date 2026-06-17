import { DEFAULT_BASE_URL, TASK_EVENT_TYPES } from "./constants.ts";
import { firstLine, formatTime, sanitizeText } from "./format.ts";
import { truncatePlain } from "./tui.ts";
import type {
	AgentTiming,
	InboxRequest,
	KanadeOverview,
	KanadeTask,
	ReviewSummary,
	ServerEvent,
	SessionEntry,
	SessionEvent,
	SessionListItem,
	TaskDetail,
	TaskEvent,
	UsageSummary,
	WorkflowPlanStep,
	WorkflowSnapshot,
	WorktreeRow,
} from "./types.ts";

export function kanadeBaseUrl(): string {
	return (process.env.KANADE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
}

export async function getJson<T>(path: string, timeoutMs = 5000): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${kanadeBaseUrl()}${path}`, { signal: controller.signal });
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new Error(`${res.status} ${res.statusText}${body ? ` · ${truncatePlain(body, 120)}` : ""}`);
		}
		return (await res.json()) as T;
	} finally {
		clearTimeout(timer);
	}
}

export async function postJson<T>(path: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${kanadeBaseUrl()}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: controller.signal,
		});
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`${res.status} ${res.statusText}${text ? ` · ${truncatePlain(text, 180)}` : ""}`);
		}
		return (await res.json()) as T;
	} finally {
		clearTimeout(timer);
	}
}

export async function patchJson<T>(path: string, body: Record<string, unknown>, timeoutMs = 10_000): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${kanadeBaseUrl()}${path}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`${res.status} ${res.statusText}${text ? ` · ${truncatePlain(text, 180)}` : ""}`);
		}
		return (await res.json()) as T;
	} finally {
		clearTimeout(timer);
	}
}

export async function fetchTasksOverview(previousInbox: InboxRequest[] = []): Promise<KanadeOverview> {
	try {
		const tasksBody = await getJson<{ tasks: KanadeTask[] }>("/tasks");
		return {
			connected: true,
			baseUrl: kanadeBaseUrl(),
			tasks: sortTasks(tasksBody.tasks ?? []),
			inbox: previousInbox,
		};
	} catch (error) {
		return {
			connected: false,
			baseUrl: kanadeBaseUrl(),
			tasks: [],
			inbox: previousInbox,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function fetchInbox(): Promise<InboxRequest[]> {
	try {
		const inboxBody = await getJson<{ requests: InboxRequest[] }>("/inbox", 2000);
		return inboxBody.requests ?? [];
	} catch {
		return [];
	}
}

export async function fetchOverview(): Promise<KanadeOverview> {
	const overview = await fetchTasksOverview();
	if (!overview.connected) return overview;
	return { ...overview, inbox: await fetchInbox() };
}

export async function fetchTaskDetail(
	taskId: string,
	includeSession = false,
	includeEvents = false,
): Promise<TaskDetail> {
	const detail: TaskDetail = { loading: false, loadedAt: Date.now() };
	const [taskResult, snapshotResult, scriptResult, worktreesResult, sessionsResult, reviewResult] =
		await Promise.allSettled([
			getJson<{ task: KanadeTask; usage?: UsageSummary | null }>(`/tasks/${encodeURIComponent(taskId)}`),
			getJson<{ snapshot: WorkflowSnapshot }>(`/tasks/${encodeURIComponent(taskId)}/snapshot`),
			getJson<{ script: string }>(`/tasks/${encodeURIComponent(taskId)}/script`),
			getJson<{ worktrees: WorktreeRow[] }>(`/tasks/${encodeURIComponent(taskId)}/worktrees`),
			getJson<{ sessions: SessionListItem[] }>(`/tasks/${encodeURIComponent(taskId)}/sessions`),
			getJson<ReviewSummary>(`/tasks/${encodeURIComponent(taskId)}/review`),
		]);

	const errors: string[] = [];
	if (taskResult.status === "fulfilled") {
		detail.task = taskResult.value.task;
		detail.usage = taskResult.value.usage ?? null;
	} else {
		errors.push(`task: ${taskResult.reason}`);
	}

	if (includeEvents) {
		try {
			detail.taskEvents = await fetchTaskEvents(taskId);
		} catch {}
	}
	if (snapshotResult.status === "fulfilled") detail.snapshot = snapshotResult.value.snapshot;
	else detail.snapshot = null;
	if (scriptResult.status === "fulfilled") {
		detail.workflowScript = scriptResult.value.script;
		detail.workflowPlan = parseWorkflowPlan(scriptResult.value.script);
	}
	if (worktreesResult.status === "fulfilled") detail.worktrees = worktreesResult.value.worktrees ?? [];
	else detail.worktrees = [];
	if (sessionsResult.status === "fulfilled") detail.sessions = sessionsResult.value.sessions ?? [];
	else detail.sessions = [];
	if (reviewResult.status === "fulfilled") detail.review = reviewResult.value;
	else detail.review = null;

	if (includeSession && detail.sessions.length > 0) {
		const preferred = pickSession(detail.sessions);
		if (preferred) {
			try {
				const body = await getJson<{ label: string; entries: SessionEntry[]; file: string }>(
					`/tasks/${encodeURIComponent(taskId)}/sessions/${encodeURIComponent(preferred.label)}`,
				);
				detail.sessionLabel = body.label;
				detail.sessionEvents = summarizeSessionEntries(body.entries ?? []).slice(-40);
			} catch (error) {
				errors.push(`session: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	detail.timing = computeAgentTiming(detail);

	if (errors.length > 0) detail.error = errors.join("; ");
	return detail;
}

async function fetchTaskEvents(taskId: string, timeoutMs = 250): Promise<TaskEvent[]> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${kanadeBaseUrl()}/tasks/${encodeURIComponent(taskId)}/events`, {
			signal: controller.signal,
			headers: { Accept: "text/event-stream" },
		});
		if (!res.ok || !res.body) return [];
		return await collectSSEEvents(res.body, timer);
	} catch {
		return [];
	} finally {
		clearTimeout(timer);
	}
}

async function collectSSEEvents(
	body: ReadableStream<Uint8Array>,
	timer: ReturnType<typeof setTimeout>,
): Promise<TaskEvent[]> {
	const events: TaskEvent[] = [];
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let currentData = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (line.startsWith("data:")) {
					currentData = line.slice(5).trim();
					continue;
				}
				if (line.startsWith(":") || line.startsWith("event:") || line.startsWith("id:")) continue;
				if (line.trim() === "" && currentData) {
					pushParsedEvent(events, currentData);
					currentData = "";
				}
			}
		}
		if (currentData) pushParsedEvent(events, currentData);
	} catch {
		// Stream may abort; return whatever we collected
	} finally {
		reader.releaseLock();
		clearTimeout(timer);
	}
	return events;
}

function pushParsedEvent(events: TaskEvent[], rawData: string): void {
	try {
		const parsed = JSON.parse(rawData) as ServerEvent;
		if (TASK_EVENT_TYPES.includes(parsed.type)) {
			events.push({
				time: formatTime(parsed.ts),
				type: parsed.type,
				ts: parsed.ts,
				summary: summarizeTaskEvent(parsed.type, parsed.data),
			});
		}
	} catch {
		// skip malformed event
	}
}

function summarizeTaskEvent(type: string, data: unknown): string {
	const d = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
	switch (type) {
		case "task.created":
			return sanitizeText(`created${d.workflowPath ? ` · ${d.workflowPath}` : ""}`);
		case "task.running":
			return "started";
		case "task.finished":
			return "finished";
		case "task.failed":
			return sanitizeText(`failed${d.error ? ` · ${String(d.error).slice(0, 80)}` : ""}`);
		case "task.aborted":
			return "aborted";
		case "task.needs_human":
			return sanitizeText(
				`needs human${d.request ? ` · ${String((d.request as Record<string, unknown>)?.title ?? "").slice(0, 60)}` : ""}`,
			);
		case "task.human_resolved":
			return "human resolved";
		case "task.merged":
			return sanitizeText(`merged${d.mergeCommit ? ` · ${d.mergeCommit}` : ""}`);
		case "task.rejected":
			return "rejected";
		case "task.script_generated":
			return "script generated";
		case "workflow.phase":
			return sanitizeText(`phase: ${d.phase ?? ""}`);
		case "workflow.agent_started":
			return sanitizeText(`agent started${d.label ? ` · ${d.label}` : ""}`);
		case "workflow.agent_completed":
			return sanitizeText(`agent done${d.label ? ` · ${d.label}` : ""}${d.status ? ` · ${d.status}` : ""}`);
		case "workflow.log":
			return sanitizeText(truncatePlain(String(d.message ?? ""), 100));
		default:
			return type;
	}
}

function computeAgentTiming(detail: TaskDetail): AgentTiming {
	const task = detail.task;
	const sessionEvents = detail.sessionEvents ?? [];
	const taskEvents = detail.taskEvents ?? [];
	const startedAt = task?.started_at ?? task?.created_at;
	const elapsedMs =
		task?.finished_at && startedAt ? task.finished_at - startedAt : startedAt ? Date.now() - startedAt : undefined;
	const lastActivityTs = findLastActivityTs(sessionEvents, taskEvents);
	const lastActivityAt = lastActivityTs ?? startedAt;
	const idleMs = lastActivityAt ? Date.now() - lastActivityAt : undefined;
	return { startedAt, elapsedMs, lastActivityAt, idleMs };
}

function findLastActivityTs(sessionEvents: SessionEvent[], taskEvents: TaskEvent[]): number | undefined {
	let latest = 0;
	for (const ev of taskEvents) {
		if (ev.ts > latest) latest = ev.ts;
	}
	for (const ev of sessionEvents) {
		if (ev.rawTs && ev.rawTs > latest) latest = ev.rawTs;
	}
	return latest > 0 ? latest : undefined;
}

function parseWorkflowPlan(script: string): WorkflowPlanStep[] {
	const steps: WorkflowPlanStep[] = [];
	let phase = "Workflow";
	let conditionalDepth = 0;
	for (const rawLine of script.split("\n")) {
		const line = rawLine.trim();
		const phaseMatch = line.match(/\bphase\(\s*['"`]([^'"`]+)['"`]\s*\)/);
		if (phaseMatch?.[1]) {
			phase = phaseMatch[1];
			conditionalDepth = line.includes("if ") || line.startsWith("if(") ? 1 : conditionalDepth;
			continue;
		}
		if (/^if\b|^if\s*\(/.test(line)) conditionalDepth++;
		const helperMatch = line.match(
			/\b(implement|reviewChange|continueImplementation|testChange|requestHuman|askHuman)\s*\(/,
		);
		if (helperMatch?.[1]) {
			steps.push({
				phase,
				helper: helperMatch[1],
				label: workflowHelperLabel(helperMatch[1]),
				conditional: conditionalDepth > 0,
			});
		}
		if (line.includes("}") && conditionalDepth > 0) conditionalDepth--;
	}
	return steps;
}

function workflowHelperLabel(helper: string): string {
	if (helper === "implement") return "implement";
	if (helper === "reviewChange") return "review";
	if (helper === "continueImplementation") return "fix";
	if (helper === "testChange") return "validate";
	if (helper === "requestHuman" || helper === "askHuman") return "human gate";
	return helper;
}

function pickSession(sessions: SessionListItem[]): SessionListItem | undefined {
	return [...sessions].sort((a, b) => {
		const aLatest = a.files.at(-1) ?? "";
		const bLatest = b.files.at(-1) ?? "";
		return bLatest.localeCompare(aLatest);
	})[0];
}

function summarizeSessionEntries(entries: SessionEntry[]): SessionEvent[] {
	const events: SessionEvent[] = [];
	for (const entry of entries) {
		const time = formatTime(entry.timestamp);
		const rawTs = typeof entry.timestamp === "number" ? entry.timestamp : undefined;
		if (entry.type === "model_change") {
			events.push({
				time,
				rawTs,
				label: "model",
				summary: `${entry.provider ?? "provider"}/${entry.modelId ?? "model"}`,
			});
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!message?.content) continue;
		for (const part of message.content) {
			const type = String(part.type ?? "");
			if (type === "thinking") {
				events.push({ time, rawTs, label: "think", summary: firstLine(String(part.thinking ?? "thinking"), 180) });
			} else if (type === "text") {
				const text = firstLine(String(part.text ?? ""), 180);
				if (text) events.push({ time, rawTs, label: message.role === "user" ? "user" : "text", summary: text });
			} else if (type === "toolCall") {
				const name = String(part.name ?? "tool");
				events.push({ time, rawTs, label: toolLabel(name), summary: summarizeToolCall(name, part), state: "running" });
			} else if (type === "toolResult") {
				const name = String(part.toolName ?? "tool");
				events.push({
					time,
					rawTs,
					label: toolLabel(name),
					summary: summarizeToolResult(name, part),
					state: part.isError ? "error" : "done",
				});
			} else if (type === "structured_output") {
				events.push({ time, rawTs, label: "out", summary: "structured output" });
			}
		}
	}
	return compactToolPairs(events);
}

function toolLabel(name: string): string {
	if (name === "bash") return "bash";
	if (name === "read") return "read";
	if (name === "edit" || name === "write") return "edit";
	if (name === "grep" || name === "find" || name === "ls") return "find";
	return truncatePlain(name, 10);
}

function summarizeToolCall(name: string, part: Record<string, unknown>): string {
	const args =
		typeof part.arguments === "object" && part.arguments !== null ? (part.arguments as Record<string, unknown>) : {};
	const path = typeof args.path === "string" ? args.path : undefined;
	const command = typeof args.command === "string" ? args.command : undefined;
	const query = typeof args.query === "string" ? args.query : undefined;
	return truncatePlain(path ?? command ?? query ?? name, 180);
}

function summarizeToolResult(name: string, part: Record<string, unknown>): string {
	const content = Array.isArray(part.content) ? part.content : [];
	const text = content
		.map((item) => (typeof item === "object" && item !== null && "text" in item ? String(item.text) : ""))
		.filter(Boolean)
		.join(" ");
	if (!text) return `${name} complete`;
	if (/\b(\d+) lines?\b/i.test(text)) return RegExp.lastMatch;
	if (/\b(\d+) matches?\b/i.test(text)) return RegExp.lastMatch;
	return firstLine(text, 180);
}

function compactToolPairs(events: SessionEvent[]): SessionEvent[] {
	const compact: SessionEvent[] = [];
	for (const event of events) {
		const previous = compact.at(-1);
		if (
			previous &&
			previous.label === event.label &&
			previous.summary === event.summary &&
			previous.state === "running"
		) {
			previous.state = event.state ?? "done";
			continue;
		}
		compact.push(event);
	}
	return compact;
}

function sortTasks(tasks: KanadeTask[]): KanadeTask[] {
	const priority = (task: KanadeTask): number => {
		switch (task.status) {
			case "needs_human":
				return 0;
			case "running":
			case "created":
				return 1;
			default:
				return 2;
		}
	};
	return [...tasks].sort((a, b) => priority(a) - priority(b) || Number(b.created_at ?? 0) - Number(a.created_at ?? 0));
}
