import { describe, expect, it } from "vitest";
import { parseMetricCommandOutput } from "../src/core/autoresearch/metric-command.js";

/**
 * The safety claim the metric-command design rests on: a measurement that did not happen must never
 * promote a candidate. The host encodes that twice over — status "crashed", and the failure reason
 * pushed into proxySignals — and the learning disposition rejects on either.
 *
 * deriveAutoResearchLearningDisposition (default-prime.ts:3395-3412) returns
 * { outcome: "rejected", progressKind: "none" } when `measurement.status !== "complete"` OR when
 * `measurement.proxySignals.length > 0`. Both conditions hold for every failure path below, so a
 * crashed measurement cannot reach "positive"/"verified" even if its numbers looked good.
 *
 * These pin the parser half of that contract: every failure yields a rejection, never a measurement
 * that could be mistaken for a real one.
 */
describe("a measurement that did not happen cannot look like one", () => {
	const failures: readonly [string, string][] = [
		["non-JSON stdout", "evaluation crashed"],
		["empty stdout", ""],
		["missing metricValue", '{"baselineMetricValue":0,"sampleCount":1,"variance":0}'],
		["null metricValue", '{"metricValue":null,"baselineMetricValue":0,"sampleCount":1,"variance":0}'],
		["zero sampleCount", '{"metricValue":9,"baselineMetricValue":0,"sampleCount":0,"variance":0}'],
		["negative variance", '{"metricValue":9,"baselineMetricValue":0,"sampleCount":1,"variance":-1}'],
	];

	for (const [name, stdout] of failures)
		it(`rejects ${name} rather than returning a usable measurement`, () => {
			const parsed = parseMetricCommandOutput(stdout);
			expect("error" in parsed).toBe(true);
			expect("metricValue" in parsed).toBe(false);
		});

	it("a spectacular-looking metric still rejects when the sample count is degenerate", () => {
		// The shape a gamed evaluation takes: a wonderful number computed over almost nothing. The
		// parser refuses it before any downstream comparison sees the number at all.
		const parsed = parseMetricCommandOutput(
			'{"metricValue":0.99,"baselineMetricValue":0.01,"sampleCount":0,"variance":0}',
		);
		expect(parsed).toEqual({ error: "sampleCount must be a positive integer" });
	});
});
