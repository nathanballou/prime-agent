import { describe, expect, it } from "vitest";
import {
	type CanonicalDaemonRuntimeAttestation,
	classifyDaemonRuntimeMismatch,
} from "../src/modes/daemon/daemon-runtime-identity.js";

/**
 * `list`, `attach` and `workflow-*` only observe. Refusing them on a build-id difference locks the
 * operator out of a running session they may need to steer, and the stale-daemon error's advice is
 * `shutdown --force`, which stops every agent on the machine. That happened during a live overnight
 * run: committing moved the build id and the CLI stopped talking to a perfectly healthy session.
 *
 * The gate in daemon-command.ts now proceeds for a source-class mismatch and still refuses a
 * wire-class one. These pin the classification that decision rests on.
 */
describe("read-only commands versus daemon drift", () => {
	const fields = (...names: string[]): readonly (keyof CanonicalDaemonRuntimeAttestation)[] =>
		names as readonly (keyof CanonicalDaemonRuntimeAttestation)[];

	it("treats the build-id-only mismatch that caused the lockout as source drift", () => {
		// The exact observed mismatch: sourceBuildId and installedBuildId differed, protocol 7 and the
		// schema id were identical on both sides.
		expect(classifyDaemonRuntimeMismatch(fields("sourceBuildId", "installedBuildId"))).toBe("source");
	});

	it("still calls a protocol or schema difference a wire break, which must keep refusing", () => {
		expect(classifyDaemonRuntimeMismatch(fields("protocolVersion"))).toBe("wire");
		expect(classifyDaemonRuntimeMismatch(fields("schemaId"))).toBe("wire");
		expect(classifyDaemonRuntimeMismatch(fields("schemaRevision"))).toBe("wire");
	});

	it("lets one wire field outrank any number of source fields", () => {
		expect(
			classifyDaemonRuntimeMismatch(fields("sourceBuildId", "installedBuildId", "codeTreeDigest", "schemaRevision")),
		).toBe("wire");
	});

	it("does not invent a wire break from an empty mismatch set", () => {
		expect(classifyDaemonRuntimeMismatch(fields())).toBe("source");
	});
});
