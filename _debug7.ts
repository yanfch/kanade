import { createMockSessionFactory } from "./test/e2e-mock/mock-session.ts";
import { createE2EContext, waitForTask } from "./test/e2e-mock/setup.ts";

async function main() {
	const mock = createMockSessionFactory({ text: "ok" });
	const ctx = createE2EContext(mock.createSession);
	try {
		// Only run first agent
		const task = ctx.taskManager.create({
			source: "inline",
			script: `export const meta = { name: 'test', description: 'Test' }
const a = await agent('task A', { label: 'dev', isolation: 'worktree' })
return { a }`,
		});
		await waitForTask(ctx.taskManager, task.task_id).catch((e: Error) => console.log("error:", e.message));
		console.log("1 agent - sessions:", mock.sessions.length);
		console.log("1 agent - status:", ctx.taskManager.get(task.task_id)?.status);
		console.log("1 agent - error:", ctx.taskManager.get(task.task_id)?.error);
	} finally {
		ctx.cleanup();
	}
}
main();
