import { describe, expect, it } from "vitest";
import { normalizeWorkflowTaskGraphSource } from "../src/core/workflow/brainstorm.js";
import { WORKFLOW_REQUIRED_TASK_ROLES, workflowSkillsForRole } from "../src/core/workflow/recipes.js";

function task(taskId: string, role: string, deps: readonly string[], skills?: readonly string[]): unknown {
	return {
		taskId,
		objective: "do the thing",
		requirementIds: ["req"],
		completionCriteria: ["done"],
		dependencyTaskIds: deps,
		boundaryIds: ["inv"],
		inputRefs: [],
		outputRefs: [`artifacts/${taskId}.json`],
		evidencePolicy: { kind: "command", maxBytes: 4096, maxItems: 4, independent: true },
		budget: { tokenLimit: 8000, wallTimeLimitSeconds: 120, spendLimitMicrounits: 0 },
		recovery: "retry",
		authority: ["read_workspace"],
		role,
		...(skills === undefined ? {} : { skills }),
	};
}

// Every accepted graph must contain a verification task and end with a red-team task, so a fixture
// exercising one role still has to be a legal graph.
function sourceWithTask(role: string, skills?: readonly string[]): unknown {
	// The subject task, a verification task (required in every graph), and a terminal red-team task
	// that depends on both and has nothing depending on it.
	const subject = task("t1", role, role === "red-team" ? ["verify-t1"] : [], skills);
	const needsVerify = role !== "verification";
	const middle = needsVerify ? [task("verify-t1", "verification", role === "red-team" ? [] : ["t1"])] : [];
	const priorIds = ["t1", ...(needsVerify ? ["verify-t1"] : [])];
	const terminal = role === "red-team" ? [] : [task("attack-t1", "red-team", priorIds)];
	const tasks = role === "red-team" ? [...middle, subject] : [subject, ...middle, ...terminal];
	return { schemaVersion: 1, graphRevision: 1, tasks };
}

describe("workflow role default skills", () => {
	it("attaches a role's defaults when the plan named no skills", () => {
		// The point is minimising instruction: a red-team task carries its corrections without
		// anyone sending them.
		expect(workflowSkillsForRole("red-team", undefined)).toContain("ponytail");
	});

	it("adds to declared skills rather than replacing them", () => {
		const merged = workflowSkillsForRole("implementation", ["mempalace"]);
		expect(merged[0]).toBe("mempalace");
		expect(merged).toContain("test-driven-development");
	});

	it("cannot be used to drop a role's defaults", () => {
		expect(workflowSkillsForRole("verification", ["edit"])).toContain("verification-before-completion");
	});

	it("does not duplicate a default the plan already named", () => {
		expect(workflowSkillsForRole("red-team", ["ponytail"]).filter((s) => s === "ponytail")).toHaveLength(1);
	});

	it("leaves a role with no defaults exactly as declared", () => {
		expect(workflowSkillsForRole("lens", ["edit"])).toEqual(["edit"]);
		expect(workflowSkillsForRole(undefined, undefined)).toEqual([]);
	});

	it("covers every role a graph is required to contain", () => {
		for (const role of WORKFLOW_REQUIRED_TASK_ROLES) {
			expect(workflowSkillsForRole(role, undefined).length).toBeGreaterThan(0);
		}
	});

	it("is actually applied when a real graph source is normalized", () => {
		// Guards the defect this codebase keeps producing: a resolver that exists, passes its unit
		// tests, and is never called on a live path.
		// Look the task up by id: normalization may reorder, so position is not identity.
		const normalized = normalizeWorkflowTaskGraphSource(sourceWithTask("red-team")) as {
			tasks: readonly { taskId: string; skills?: readonly string[] }[];
		};
		const subject = normalized.tasks.find((t) => t.taskId === "t1");
		expect(subject?.skills).toContain("ponytail");
	});

	it("keeps a plan's own skills when normalizing, and still adds the role's", () => {
		const normalized = normalizeWorkflowTaskGraphSource(sourceWithTask("implementation", ["mempalace"])) as {
			tasks: readonly { taskId: string; skills?: readonly string[] }[];
		};
		const subject = normalized.tasks.find((t) => t.taskId === "t1");
		expect(subject?.skills).toContain("mempalace");
		expect(subject?.skills).toContain("test-driven-development");
	});
});
