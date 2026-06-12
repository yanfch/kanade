import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ProjectProfileSnapshot {
	root: string;
	detectedStacks: string[];
	indicators: string[];
	suggestedPrepareCommands: string[];
	suggestedCheckCommands: string[];
	summary: string;
}

const NODE_MARKERS = ["package.json", "pnpm-lock.yaml", "yarn.lock", "package-lock.json", "tsconfig.json"];
const MAVEN_MARKERS = ["pom.xml", "mvnw", "src/main/java", "src/test/java"];
const GRADLE_MARKERS = ["build.gradle", "build.gradle.kts", "gradlew", "settings.gradle", "settings.gradle.kts"];
const PYTHON_MARKERS = ["pyproject.toml", "requirements.txt", "setup.py", "pytest.ini", "tox.ini", "tests/"];
const RUST_MARKERS = ["Cargo.toml", "Cargo.lock", "src/main.rs", "src/lib.rs"];
const GO_MARKERS = ["go.mod", "go.sum"];
const MAKE_MARKERS = ["Makefile", "makefile", "GNUmakefile"];
const JUST_MARKERS = ["Justfile", "justfile"];
const TASKFILE_MARKERS = ["Taskfile.yml", "Taskfile.yaml"];
const DOCS_ONLY_MARKERS = ["README.md", "readme.md", "docs/", "doc/", "CONTRIBUTING.md", "CHANGELOG.md"];

function exists(root: string, path: string): boolean {
	return existsSync(join(root, path));
}

function pushUnique(items: string[], value: string): void {
	if (!items.includes(value)) items.push(value);
}

function hasAny(root: string, markers: string[]): boolean {
	return markers.some((marker) => exists(root, marker));
}

function markerNames(root: string, markers: string[]): string[] {
	return markers.filter((marker) => exists(root, marker));
}

function pushMarkersIfPresent(root: string, markers: string[], indicators: string[]): void {
	for (const marker of markerNames(root, markers)) {
		pushUnique(indicators, marker);
	}
}

export function detectProjectProfile(root: string): ProjectProfileSnapshot {
	const profileRoot = resolve(root);
	const detectedStacks: string[] = [];
	const indicators: string[] = [];
	const suggestedPrepareCommands: string[] = [];
	const suggestedCheckCommands: string[] = [];

	const nodeFound = markerNames(profileRoot, NODE_MARKERS);
	if (nodeFound.length > 0) {
		detectedStacks.push("node");
		pushMarkersIfPresent(profileRoot, nodeFound, indicators);
		if (exists(profileRoot, "pnpm-lock.yaml")) {
			pushUnique(suggestedPrepareCommands, "pnpm install");
			pushUnique(suggestedCheckCommands, "pnpm test");
		} else if (exists(profileRoot, "yarn.lock")) {
			pushUnique(suggestedPrepareCommands, "yarn install");
			pushUnique(suggestedCheckCommands, "yarn test");
		} else if (exists(profileRoot, "package-lock.json")) {
			pushUnique(suggestedPrepareCommands, "npm ci");
			pushUnique(suggestedCheckCommands, "npm test");
		} else if (exists(profileRoot, "package.json")) {
			pushUnique(suggestedPrepareCommands, "npm install");
			pushUnique(suggestedCheckCommands, "npm test");
		}
	}

	if (exists(profileRoot, "pom.xml")) {
		detectedStacks.push("java-maven");
		pushMarkersIfPresent(profileRoot, MAVEN_MARKERS, indicators);
		if (exists(profileRoot, "mvnw")) {
			pushUnique(suggestedPrepareCommands, "./mvnw -q -DskipTests dependency:go-offline");
			pushUnique(suggestedCheckCommands, "./mvnw test");
		} else {
			pushUnique(suggestedPrepareCommands, "mvn -q -DskipTests dependency:go-offline");
			pushUnique(suggestedCheckCommands, "mvn test");
		}
	}

	if (hasAny(profileRoot, GRADLE_MARKERS)) {
		detectedStacks.push("java-gradle");
		pushMarkersIfPresent(profileRoot, GRADLE_MARKERS, indicators);
		if (exists(profileRoot, "gradlew")) {
			pushUnique(suggestedCheckCommands, "./gradlew test");
		} else {
			pushUnique(suggestedCheckCommands, "gradle test");
		}
	}

	if (hasAny(profileRoot, PYTHON_MARKERS)) {
		detectedStacks.push("python");
		pushMarkersIfPresent(profileRoot, PYTHON_MARKERS, indicators);
		if (exists(profileRoot, "requirements.txt")) {
			pushUnique(suggestedPrepareCommands, "python -m pip install -r requirements.txt");
		} else if (hasAny(profileRoot, ["pyproject.toml", "setup.py"])) {
			pushUnique(suggestedPrepareCommands, "python -m pip install -e .");
		}
		if (hasAny(profileRoot, ["pytest.ini", "tox.ini", "tests/"])) {
			pushUnique(suggestedCheckCommands, "python -m pytest");
		}
	}

	if (hasAny(profileRoot, RUST_MARKERS)) {
		detectedStacks.push("rust");
		pushMarkersIfPresent(profileRoot, RUST_MARKERS, indicators);
		pushUnique(suggestedPrepareCommands, "cargo fetch");
		pushUnique(suggestedCheckCommands, "cargo test");
	}

	if (hasAny(profileRoot, GO_MARKERS)) {
		detectedStacks.push("go");
		pushMarkersIfPresent(profileRoot, GO_MARKERS, indicators);
		pushUnique(suggestedPrepareCommands, "go mod download");
		pushUnique(suggestedCheckCommands, "go test ./...");
	}

	if (hasAny(profileRoot, MAKE_MARKERS)) {
		detectedStacks.push("make");
		pushMarkersIfPresent(profileRoot, MAKE_MARKERS, indicators);
		pushUnique(suggestedCheckCommands, "make test (if target exists)");
	}

	if (hasAny(profileRoot, JUST_MARKERS)) {
		detectedStacks.push("just");
		pushMarkersIfPresent(profileRoot, JUST_MARKERS, indicators);
		pushUnique(suggestedCheckCommands, "just test (if recipe exists)");
	}

	if (hasAny(profileRoot, TASKFILE_MARKERS)) {
		detectedStacks.push("taskfile");
		pushMarkersIfPresent(profileRoot, TASKFILE_MARKERS, indicators);
		pushUnique(suggestedCheckCommands, "task test (if task exists)");
	}

	if (detectedStacks.length === 0 && hasAny(profileRoot, DOCS_ONLY_MARKERS)) {
		detectedStacks.push("docs-only");
		pushMarkersIfPresent(profileRoot, DOCS_ONLY_MARKERS, indicators);
	}

	const summary =
		detectedStacks.length === 0
			? "No supported project markers were found. Treat checks as task-specific and do not force npm/Java/Python defaults."
			: detectedStacks.includes("docs-only")
				? `Detected docs-only markers at ${profileRoot}. Treat checks as documentation-specific; do not force language build defaults.`
				: `Detected ${detectedStacks.join(", ")} markers at ${profileRoot}`;

	return {
		root: profileRoot,
		detectedStacks: detectedStacks.length > 0 ? detectedStacks : ["unknown"],
		indicators,
		suggestedPrepareCommands,
		suggestedCheckCommands,
		summary,
	};
}

export function renderProjectProfileSummary(profile: ProjectProfileSnapshot): string {
	const lines = [
		"Workspace profile snapshot (advisory):",
		"- Use this deterministic scan as context only; prefer explicit user instructions when they conflict.",
		`- detectedStacks: ${profile.detectedStacks.join(", ")}`,
		`- indicators: ${profile.indicators.length ? profile.indicators.join(", ") : "none"}`,
		`- suggestedPrepareCommands: ${
			profile.suggestedPrepareCommands.length ? profile.suggestedPrepareCommands.join(", ") : "none"
		}`,
		`- suggestedCheckCommands: ${
			profile.suggestedCheckCommands.length ? profile.suggestedCheckCommands.join(", ") : "none"
		}`,
		`- summary: ${profile.summary}`,
	];
	return lines.join("\n");
}
