import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectProjectProfile, renderProjectProfileSummary } from "./project-profile.ts";

describe("project-profile detection", () => {
	it("detects Maven and prefers wrapper commands when mvnw exists", () => {
		const root = mkdtempSync(join(tmpdir(), "kanade-project-profile-maven-"));
		mkdirSync(join(root, "src/main/java"), { recursive: true });
		mkdirSync(join(root, "src/test/java"), { recursive: true });
		writeFileSync(join(root, "pom.xml"), "<project />");
		writeFileSync(join(root, "mvnw"), "#!/bin/bash\necho mvn wrapper");

		try {
			const profile = detectProjectProfile(root);
			expect(profile.detectedStacks).toContain("java-maven");
			expect(profile.indicators).toContain("mvnw");
			expect(profile.suggestedPrepareCommands).toContain("./mvnw -q -DskipTests dependency:go-offline");
			expect(profile.suggestedCheckCommands).toContain("./mvnw test");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("detects Python and suggests pytest checks", () => {
		const root = mkdtempSync(join(tmpdir(), "kanade-project-profile-python-"));
		writeFileSync(join(root, "requirements.txt"), "pytest==8.0.0");
		writeFileSync(join(root, "pytest.ini"), "[pytest]\n");
		mkdirSync(join(root, "tests"), { recursive: true });

		try {
			const profile = detectProjectProfile(root);
			expect(profile.detectedStacks).toContain("python");
			expect(profile.indicators).toContain("pytest.ini");
			expect(profile.suggestedPrepareCommands).toContain("python -m pip install -r requirements.txt");
			expect(profile.suggestedCheckCommands).toContain("python -m pytest");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("detects Makefile and Justfile markers and suggests runner guidance", () => {
		const root = mkdtempSync(join(tmpdir(), "kanade-project-profile-runner-"));
		writeFileSync(join(root, "Makefile"), "test:\n\t@echo test\n");
		writeFileSync(join(root, "Justfile"), "test:\n\techo test\n");

		try {
			const profile = detectProjectProfile(root);
			expect(profile.detectedStacks).toContain("make");
			expect(profile.detectedStacks).toContain("just");
			expect(profile.suggestedPrepareCommands).toContain("make");
			expect(profile.suggestedPrepareCommands).toContain("just");
			expect(profile.suggestedCheckCommands).toContain("make test");
			expect(profile.suggestedCheckCommands).toContain("just test");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("supports mixed-stack detection without failure", () => {
		const root = mkdtempSync(join(tmpdir(), "kanade-project-profile-mixed-"));
		writeFileSync(join(root, "package.json"), '{"name":"demo"}');
		writeFileSync(join(root, "go.mod"), "module demo\n");
		writeFileSync(join(root, "pyproject.toml"), '[project]\nname = "demo"\n');

		try {
			const profile = detectProjectProfile(root);
			expect(profile.detectedStacks).toEqual(expect.arrayContaining(["node", "go", "python"]));
			expect(profile.suggestedPrepareCommands).toContain("npm install");
			expect(profile.suggestedPrepareCommands).toContain("go mod download");
			expect(profile.suggestedCheckCommands).toContain("go test ./...");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns unknown with no forced defaults for an empty project", () => {
		const root = mkdtempSync(join(tmpdir(), "kanade-project-profile-unknown-"));
		try {
			const profile = detectProjectProfile(root);
			expect(profile.detectedStacks).toEqual(["unknown"]);
			expect(profile.suggestedPrepareCommands).toEqual([]);
			expect(profile.suggestedCheckCommands).toEqual([]);
			expect(profile.summary).toMatch(/No supported project markers/i);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("renders deterministic profile summary", () => {
		const root = mkdtempSync(join(tmpdir(), "kanade-project-profile-summary-"));
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src/main.rs"), "fn main() {}\n");
		writeFileSync(join(root, "Cargo.toml"), '[package]\nname="demo"\n');

		try {
			const profile = detectProjectProfile(root);
			const rendered = renderProjectProfileSummary(profile);
			expect(rendered).toContain("Workspace profile snapshot");
			expect(rendered).toContain("rust");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
