import { homedir } from "node:os";
import { join } from "node:path";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

const agentDir = join(homedir(), ".pi/agent");
const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));

const models = modelRegistry.getAll();
console.log("Total models:", models.length);
for (const m of models) {
	console.log(`  ${m.provider}/${m.id} (${m.name})`);
}

const mimo = models.find((m) => m.id === "mimo-v2.5-pro");
console.log("\nmimo-v2.5-pro:", mimo ? JSON.stringify(mimo, null, 2) : "NOT FOUND");
