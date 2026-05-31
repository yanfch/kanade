import { createMockSessionFactory } from "./test/e2e-mock/mock-session.ts";
import { createE2EContext, waitForTask } from "./test/e2e-mock/setup.ts";

async function main() {
	let callCount = 0;
	const mock = createMockSessionFactory({
		handler: () => {
			callCount++;
			console.log(`  session ${callCount} created`);
			return { type: "text", text: `ok-${callCount}` };
		},
	});
	const ctx = createE2EContext(mock.createSession);
	try {
		const task = ctx.taskManager.create({
			source: "inline",
			script: `export const meta = { name: 'test', description: 'Test' }
try {
  const a = await agent('task A', { label: 'dev', isolation: 'worktree' })
  console.log('agent A result:', a)
} catch(e) {
  console.log('agent A error:', e.message)
}
try {
  const b = await agent('task B', { label: 'review', isolation: 'worktree' })
  console.log('agent B result:', b)
} catch(e) {
  console.log('agent B error:', e.message)
}
return 'done'`,
		});
		await waitForTask(ctx.taskManager, task.task_id).catch((e: Error) => console.log("waitForTask error:", e.message));
		console.log("sessions:", mock.sessions.length);
	} finally {
		ctx.cleanup();
	}
}
main();
