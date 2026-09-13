import { isDeepStrictEqual } from "node:util";
import type { WorkflowStepResult } from "./types.js";

export function resolveTemplate(
	input: string,
	args: Record<string, unknown>,
	results: Record<string, WorkflowStepResult>,
) {
	const withArgs = resolveArgsTemplate(input, args);
	return resolveStepRefs(withArgs, results);
}

export function resolveArgsTemplate(input: string, args: Record<string, unknown>) {
	return input.replace(/\$\{([A-Za-z0-9_-]+)\}/g, (match, key) => {
		if (Object.hasOwn(args, key)) return String(args[key]);
		return match;
	});
}

function resolveStepRefs(input: string, results: Record<string, WorkflowStepResult>) {
	return input.replace(
		/\$([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)/g,
		(match, id, pathValue) => {
			if (!(id in results)) {
				return match;
			}
			const refValue = getStepRefValue({ id, path: pathValue }, results, false);
			if (refValue === undefined) {
				if (pathValue === "approved" || pathValue === "skipped") return "false";
				return "";
			}
			return renderTemplateValue(refValue);
		},
	);
}

export function parseStepRef(value: string) {
	const match = value.match(/^\$([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)$/);
	if (!match) return null;
	return { id: match[1], path: match[2] };
}

export function getStepRefValue(
	ref: { id: string; path: string },
	results: Record<string, WorkflowStepResult>,
	strict: boolean,
) {
	const step = results[ref.id];
	if (!step) {
		if (strict) throw new Error(`Unknown step reference: ${ref.id}.${ref.path}`);
		return undefined;
	}
	return getValueByPath(step, ref.path);
}

export function evaluateCondition(condition: unknown, results: Record<string, WorkflowStepResult>) {
	if (condition === undefined || condition === null) return true;
	if (typeof condition === "boolean") return condition;
	if (typeof condition !== "string") throw new Error("Unsupported condition type");

	const trimmed = condition.trim();
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	return evaluateConditionExpression(trimmed, results);
}

function renderTemplateValue(value: unknown) {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
		return String(value);
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function getValueByPath(value: unknown, pathValue: string) {
	const fields = pathValue.split(".");
	let current: unknown = value;
	for (const field of fields) {
		if (current === null || current === undefined) return undefined;
		if (Array.isArray(current)) {
			const idx = Number(field);
			if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) return undefined;
			current = current[idx];
			continue;
		}
		if (typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[field];
	}
	return current;
}

type ConditionToken =
	| {
			type: "lparen" | "rparen" | "and" | "or" | "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "not";
	  }
	| { type: "step_ref"; value: { id: string; path: string } }
	| { type: "string" | "number" | "boolean" | "null" | "identifier"; value: unknown };

function evaluateConditionExpression(
	expression: string,
	results: Record<string, WorkflowStepResult>,
) {
	const tokens = tokenizeCondition(expression);
	if (tokens.length === 0) {
		throw new Error(`Unsupported condition: ${expression}`);
	}
	let index = 0;

	function parseOr(): unknown {
		let left = parseAnd();
		while (match("or")) {
			const right = parseAnd();
			left = Boolean(left) || Boolean(right);
		}
		return left;
	}

	function parseAnd(): unknown {
		let left = parseEquality();
		while (match("and")) {
			const right = parseEquality();
			left = Boolean(left) && Boolean(right);
		}
		return left;
	}

	function parseEquality(): unknown {
		const left = parseUnary(false);
		if (match("eq")) {
			return compareConditionValues(left, parseUnary(true));
		}
		if (match("neq")) {
			return !compareConditionValues(left, parseUnary(true));
		}
		if (match("lt")) {
			return numericCompare(left, parseUnary(true), (a, b) => a < b);
		}
		if (match("lte")) {
			return numericCompare(left, parseUnary(true), (a, b) => a <= b);
		}
		if (match("gt")) {
			return numericCompare(left, parseUnary(true), (a, b) => a > b);
		}
		if (match("gte")) {
			return numericCompare(left, parseUnary(true), (a, b) => a >= b);
		}
		return left;
	}

	function parseUnary(allowBareIdentifier: boolean): unknown {
		if (match("not")) {
			return !parseUnary(allowBareIdentifier);
		}
		return parsePrimary(allowBareIdentifier);
	}

	function parsePrimary(allowBareIdentifier: boolean): unknown {
		const token = tokens[index];
		if (!token) {
			throw new Error(`Unsupported condition: ${expression}`);
		}
		index += 1;

		if (token.type === "lparen") {
			const value = parseOr();
			expect("rparen");
			return value;
		}
		if (token.type === "step_ref") {
			return getStepRefValue(token.value, results, true);
		}
		if (
			token.type === "string" ||
			token.type === "number" ||
			token.type === "boolean" ||
			token.type === "null"
		) {
			return token.value;
		}
		if (token.type === "identifier" && allowBareIdentifier) {
			return token.value;
		}
		throw new Error(`Unsupported condition: ${expression}`);
	}

	function match(type: ConditionToken["type"]) {
		if (tokens[index]?.type !== type) return false;
		index += 1;
		return true;
	}

	function expect(type: ConditionToken["type"]) {
		if (!match(type)) {
			throw new Error(`Unsupported condition: ${expression}`);
		}
	}

	const value = parseOr();
	if (index !== tokens.length) {
		throw new Error(`Unsupported condition: ${expression}`);
	}
	return Boolean(value);
}

function compareConditionValues(left: unknown, right: unknown) {
	if (
		Array.isArray(left) ||
		Array.isArray(right) ||
		isPlainConditionObject(left) ||
		isPlainConditionObject(right)
	) {
		return isDeepStrictEqual(left, right);
	}
	return Object.is(left, right);
}

function isStrictlyNumeric(value: unknown): boolean {
	if (typeof value === "number") return !Number.isNaN(value);
	if (typeof value === "string") return value.trim() !== "" && !Number.isNaN(Number(value));
	return false;
}

function numericCompare(
	left: unknown,
	right: unknown,
	cmp: (a: number, b: number) => boolean,
): boolean {
	if (!isStrictlyNumeric(left) || !isStrictlyNumeric(right)) return false;
	return cmp(Number(left), Number(right));
}

function isPlainConditionObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function tokenizeCondition(expression: string): ConditionToken[] {
	const tokens: ConditionToken[] = [];
	let index = 0;

	while (index < expression.length) {
		const ch = expression[index];
		if (/\s/.test(ch)) {
			index += 1;
			continue;
		}
		if (ch === "(") {
			tokens.push({ type: "lparen" });
			index += 1;
			continue;
		}
		if (ch === ")") {
			tokens.push({ type: "rparen" });
			index += 1;
			continue;
		}
		if (expression.startsWith("&&", index)) {
			tokens.push({ type: "and" });
			index += 2;
			continue;
		}
		if (expression.startsWith("||", index)) {
			tokens.push({ type: "or" });
			index += 2;
			continue;
		}
		if (expression.startsWith("==", index)) {
			tokens.push({ type: "eq" });
			index += 2;
			continue;
		}
		if (expression.startsWith("!=", index)) {
			tokens.push({ type: "neq" });
			index += 2;
			continue;
		}
		if (expression.startsWith("<=", index)) {
			tokens.push({ type: "lte" });
			index += 2;
			continue;
		}
		if (expression.startsWith(">=", index)) {
			tokens.push({ type: "gte" });
			index += 2;
			continue;
		}
		if (ch === "<") {
			tokens.push({ type: "lt" });
			index += 1;
			continue;
		}
		if (ch === ">") {
			tokens.push({ type: "gt" });
			index += 1;
			continue;
		}
		if (ch === "!") {
			tokens.push({ type: "not" });
			index += 1;
			continue;
		}
		if (ch === "$") {
			const matched = matchConditionStepRef(expression, index);
			if (!matched) {
				throw new Error(`Unsupported condition: ${expression}`);
			}
			tokens.push({ type: "step_ref", value: matched.ref });
			index = matched.nextIndex;
			continue;
		}
		if (ch === '"' || ch === "'") {
			const parsed = parseQuotedConditionString(expression, index, ch);
			tokens.push({ type: "string", value: parsed.value });
			index = parsed.nextIndex;
			continue;
		}
		const numberMatch = expression.slice(index).match(/^-?\d+(?:\.\d+)?/);
		if (numberMatch) {
			tokens.push({ type: "number", value: Number(numberMatch[0]) });
			index += numberMatch[0].length;
			continue;
		}
		const identMatch = expression.slice(index).match(/^[A-Za-z_][A-Za-z0-9_-]*/);
		if (identMatch) {
			const raw = identMatch[0];
			if (raw === "true") {
				tokens.push({ type: "boolean", value: true });
			} else if (raw === "false") {
				tokens.push({ type: "boolean", value: false });
			} else if (raw === "null") {
				tokens.push({ type: "null", value: null });
			} else {
				tokens.push({ type: "identifier", value: raw });
			}
			index += raw.length;
			continue;
		}
		throw new Error(`Unsupported condition: ${expression}`);
	}

	return tokens;
}

function matchConditionStepRef(expression: string, startIndex: number) {
	const match = expression
		.slice(startIndex)
		.match(/^\$([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)/);
	if (!match) return null;
	return {
		ref: { id: match[1], path: match[2] },
		nextIndex: startIndex + match[0].length,
	};
}

function parseQuotedConditionString(expression: string, startIndex: number, quoteChar: '"' | "'") {
	let value = "";
	let index = startIndex + 1;
	while (index < expression.length) {
		const ch = expression[index];
		if (ch === "\\") {
			const next = expression[index + 1];
			if (next === undefined) break;
			value += next;
			index += 2;
			continue;
		}
		if (ch === quoteChar) {
			return { value, nextIndex: index + 1 };
		}
		value += ch;
		index += 1;
	}
	throw new Error(`Unsupported condition: ${expression}`);
}
