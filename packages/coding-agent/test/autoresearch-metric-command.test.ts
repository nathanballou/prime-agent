import { describe, expect, it } from "vitest";
import { parseMetricCommandOutput } from "../src/core/autoresearch/metric-command.js";

/**
 * Every failure path returns a reason rather than a zero. A constant that reads as a measurement is
 * worse than an absent one: it promotes silently. This module exists because the previous host
 * emitted metricValue 0 against baseline 1 with cost derived from artifact byte length, and nothing
 * about that looked wrong from the outside.
 */
describe("metric command output", () => {
	it("accepts the documented shape", () => {
		expect(
			parseMetricCommandOutput('{"metricValue":0.31,"baselineMetricValue":0.12,"sampleCount":157,"variance":0.004}'),
		).toEqual({ metricValue: 0.31, baselineMetricValue: 0.12, sampleCount: 157, variance: 0.004, costMicrounits: 0 });
	});

	it("accepts a negative metric, because a candidate may be worse than its baseline", () => {
		expect(
			parseMetricCommandOutput('{"metricValue":-0.3,"baselineMetricValue":0,"sampleCount":157,"variance":0}'),
		).toEqual({ metricValue: -0.3, baselineMetricValue: 0, sampleCount: 157, variance: 0, costMicrounits: 0 });
	});

	it("refuses a non-finite metric rather than promoting NaN", () => {
		expect(
			parseMetricCommandOutput('{"metricValue":null,"baselineMetricValue":0,"sampleCount":1,"variance":0}'),
		).toEqual({ error: "metricValue must be a finite number" });
	});

	it("refuses a zero sample count, which is what an empty evaluation looks like", () => {
		expect(
			parseMetricCommandOutput('{"metricValue":1,"baselineMetricValue":0,"sampleCount":0,"variance":0}'),
		).toEqual({ error: "sampleCount must be a positive integer" });
	});

	it("refuses a negative variance", () => {
		expect(
			parseMetricCommandOutput('{"metricValue":1,"baselineMetricValue":0,"sampleCount":2,"variance":-1}'),
		).toEqual({ error: "variance must be a non-negative finite number" });
	});

	it("refuses output that is not JSON rather than treating it as zero", () => {
		expect(parseMetricCommandOutput("evaluation failed")).toEqual({ error: "stdout is not canonical JSON" });
	});

	it("refuses empty stdout", () => {
		expect(parseMetricCommandOutput("")).toEqual({ error: "stdout is not canonical JSON" });
	});

	it("reads a reported cost, so a downstream cost ceiling means something", () => {
		expect(
			parseMetricCommandOutput(
				'{"metricValue":1,"baselineMetricValue":0,"sampleCount":2,"variance":0,"costMicrounits":4200}',
			),
		).toMatchObject({ costMicrounits: 4200 });
	});

	it("treats an unreported cost as zero, which is a claim the operator opts into", () => {
		expect(
			parseMetricCommandOutput('{"metricValue":1,"baselineMetricValue":0,"sampleCount":2,"variance":0}'),
		).toMatchObject({ costMicrounits: 0 });
	});

	it("refuses a negative or fractional cost rather than rounding it", () => {
		expect(
			parseMetricCommandOutput(
				'{"metricValue":1,"baselineMetricValue":0,"sampleCount":2,"variance":0,"costMicrounits":-1}',
			),
		).toEqual({ error: "costMicrounits must be a non-negative integer when present" });
	});

	it("tolerates log lines before the measurement, because real tools print progress", () => {
		expect(
			parseMetricCommandOutput(
				'loading parquet\nweeks=157\n{"metricValue":0.5,"baselineMetricValue":0.5,"sampleCount":2,"variance":0}\n',
			),
		).toEqual({ metricValue: 0.5, baselineMetricValue: 0.5, sampleCount: 2, variance: 0, costMicrounits: 0 });
	});
});
