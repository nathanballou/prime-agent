import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildRestoreCode,
	buildSnapshotCode,
	DEFAULT_SNAPSHOT_MAX_BYTES,
	DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES,
	manifestPathIn,
	parseRestoreResult,
	parseSnapshotResult,
	snapshotPathIn,
} from "../src/core/kernel/state-snapshot.js";

const MARKER = "__PRIME_AGENT_KERNEL_STATE__";

describe("kernel state snapshot paths", () => {
	it("places snapshot + manifest inside the session artifact directory", () => {
		const artifactDir = "/home/u/.prime/agent/session-artifacts/abc-123";
		expect(snapshotPathIn(artifactDir)).toBe(join(artifactDir, "kernel-state.dill"));
		expect(manifestPathIn(artifactDir)).toBe(join(artifactDir, "kernel-state.json"));
	});
});

describe("parseSnapshotResult", () => {
	it("parses a valid marker line", () => {
		const stdout = `${MARKER}${JSON.stringify({
			saved: ["x", "y"],
			skipped: [{ name: "sock", reason: "TypeError: cannot pickle" }],
			pruned: ["large_text"],
			bytes: 1234,
		})}\n`;
		const result = parseSnapshotResult(stdout, "/tmp/s.dill");
		expect(result).toEqual({
			saved: ["x", "y"],
			skipped: [{ name: "sock", reason: "TypeError: cannot pickle" }],
			pruned: ["large_text"],
			bytes: 1234,
			path: "/tmp/s.dill",
		});
	});

	it("ignores stdout printed before the marker line", () => {
		const stdout = `some earlier print output\n${MARKER}${JSON.stringify({ saved: ["a"], skipped: [], bytes: 7 })}`;
		expect(parseSnapshotResult(stdout, "/tmp/s.dill")?.saved).toEqual(["a"]);
	});

	it("returns null when the marker is absent", () => {
		expect(parseSnapshotResult("no marker here", "/tmp/s.dill")).toBeNull();
	});

	it("returns null when the payload reports an error", () => {
		const stdout = `${MARKER}${JSON.stringify({ error: "dill unavailable" })}`;
		expect(parseSnapshotResult(stdout, "/tmp/s.dill")).toBeNull();
	});

	it("returns null on malformed JSON", () => {
		expect(parseSnapshotResult(`${MARKER}{not json`, "/tmp/s.dill")).toBeNull();
	});

	it("tolerates missing fields", () => {
		const result = parseSnapshotResult(`${MARKER}{}`, "/tmp/s.dill");
		expect(result).toEqual({ saved: [], skipped: [], bytes: 0, path: "/tmp/s.dill" });
	});

	it("parses bounded checkpoint metadata without retaining raw values", () => {
		const result = parseSnapshotResult(
			`${MARKER}${JSON.stringify({
				saved: ["answer"],
				skipped: [],
				bytes: 128,
				checkpointTurn: 4,
				serializationDurationMs: 12,
				previousCheckpointTurn: 3,
				previousDurableBytes: 96,
				retainedValues: [
					{
						valueId: "answer",
						type: "list",
						bytes: 128,
						classification: "durable_fact",
						required: true,
						representation: "durable",
						digest: "a".repeat(64),
						artifactRef: null,
						reason: null,
					},
				],
				largestRetainedValues: [{ valueId: "answer", type: "list", bytes: 128, classification: "durable_fact" }],
				raw: "secret-value-that-must-not-be-retained",
			})}\n`,
			"/tmp/s.dill",
		);

		expect(result).toMatchObject({
			checkpointTurn: 4,
			serializationDurationMs: 12,
			previousCheckpointTurn: 3,
			previousDurableBytes: 96,
			growthBytesPerTurn: 32,
			retainedValues: [{ valueId: "answer", type: "list", bytes: 128, classification: "durable_fact" }],
			largestRetainedValues: [{ valueId: "answer", type: "list", bytes: 128, classification: "durable_fact" }],
		});
		expect(JSON.stringify(result)).not.toContain("secret-value");
	});
});

describe("parseRestoreResult", () => {
	it("parses restored and failed names", () => {
		const stdout = `${MARKER}${JSON.stringify({
			restored: ["df", "model"],
			failed: [{ name: "conn", reason: "TypeError" }],
		})}`;
		expect(parseRestoreResult(stdout, "/tmp/s.dill")).toEqual({
			restored: ["df", "model"],
			failed: [{ name: "conn", reason: "TypeError" }],
			path: "/tmp/s.dill",
		});
	});

	it("returns null when the marker is absent", () => {
		expect(parseRestoreResult("", "/tmp/s.dill")).toBeNull();
	});

	it("returns null when the payload reports an error", () => {
		expect(parseRestoreResult(`${MARKER}${JSON.stringify({ error: "load failed" })}`, "/tmp/s.dill")).toBeNull();
	});
});

describe("buildSnapshotCode", () => {
	const code = buildSnapshotCode("/state/sess.dill", "/state/sess.json", DEFAULT_SNAPSHOT_MAX_BYTES);

	it("embeds the output, manifest paths, and the byte cap", () => {
		expect(code).toContain('"/state/sess.dill"');
		expect(code).toContain('"/state/sess.json"');
		expect(code).toContain(String(DEFAULT_SNAPSHOT_MAX_BYTES));
		expect(code).toContain(String(DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES));
	});

	it("uses dill, an atomic write, and skips internal handles", () => {
		expect(code).toContain("import dill");
		expect(code).toContain("os.replace");
		expect(code).toContain("except _b.KeyboardInterrupt");
		// Staging paths are per-process so two kernels sharing a session directory
		// cannot interleave writes into one temp file.
		expect(code).toContain('_tmp_suffix = ".tmp." + _b.str(os.getpid())');
		expect(code).not.toContain('+ ".tmp"');
		expect(code).toContain('"rlm"');
		expect(code).toContain(`print(${JSON.stringify(MARKER)}`);
	});
});

describe("buildRestoreCode", () => {
	const code = buildRestoreCode("/state/sess.dill");

	it("embeds the input path and no-ops when the file is missing", () => {
		expect(code).toContain('"/state/sess.dill"');
		expect(code).toContain("os.path.exists");
		expect(code).toContain("dill.loads");
	});
});

/** Manifest keys the snapshot writer emits, read out of the generated Python literal. */
function writerManifestKeys(code: string): string[] {
	const body = code.slice(code.indexOf("_manifest = {"), code.indexOf("_manifest_tmp ="));
	return [...body.matchAll(/^\s{8}"([A-Za-z]+)":/gm)].map(([, key]) => key).sort();
}

/** Manifest keys the restore path will accept, read out of its exact-match key set. */
function readerManifestKeys(code: string): string[] {
	const body = code.slice(code.indexOf("_expected_manifest_keys = {"), code.indexOf("if _b.set(_manifest.keys())"));
	return [...body.matchAll(/"([A-Za-z]+)"/g)].map(([, key]) => key).sort();
}

describe("snapshot manifest contract", () => {
	// The reader compares the manifest key set for exact equality, so a key added on
	// one side and not the other makes every committed checkpoint unrestorable.
	it("writes exactly the manifest keys the restore path accepts", () => {
		expect(writerManifestKeys(buildSnapshotCode("/state/sess.dill", "/state/sess.json", 1024))).toEqual(
			readerManifestKeys(buildRestoreCode("/state/sess.dill", "/state/sess.json")),
		);
	});
});
