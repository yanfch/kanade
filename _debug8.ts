import { createMockSessionFactory } from "./test/e2e-mock/mock-session.ts";
import { createE2EContext, waitForTask } from "./test/e2e-mock/setup.ts";

async function main() {
	const mock = createMockSessionFactory({ text: "ok" });
	const ctx = createE2EContext(mock.createSession);
	try {
		const task = ctx.taskManager.create({
			source: "inline",
			script: `export const meta = { name: 'test', description: 'Test' }
const a = await agent('task A', { label: 'dev', isolation: 'worktree' })
const b = await agent('task B', { label: 'review', isolation: 'worktree' })
return { a, b }`,
		});
		await waitForTask(ctx.taskManager, task.task_id).catch((e: Error) => console.log("waitForTask error:", e.message));
		console.log("status:", ctx.taskManager.get(task.task_id)?.status);
		console.log("error:", ctx.taskManager.get(task.task_id)?.error);
		console.log("sessions:", mock.sessions.length);
	} finally {
		ctx.cleanup();
	}
}
main();
