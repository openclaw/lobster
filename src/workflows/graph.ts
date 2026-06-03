import type { WorkflowFile, WorkflowStep } from "./file.js";

export type WorkflowGraphFormat = "mermaid" | "dot" | "ascii";

type GraphNode = {
  id: string;
  type: string;
  label: string;
  shape: "box" | "diamond";
};

type GraphEdge = {
  from: string;
  to: string;
  label?: string;
};

type RenderGraphParams = {
  workflow: WorkflowFile;
  format: WorkflowGraphFormat;
  args?: Record<string, unknown>;
};

function resolveArgsTemplate(input: string, args: Record<string, unknown>) {
  return input.replace(/\$\{([A-Za-z0-9_-]+)\}/g, (match, key) => {
    if (key in args) return String(args[key]);
    return match;
  });
}

function isApprovalStep(step: WorkflowStep) {
  if (step.approval === true) return true;
  if (typeof step.approval === "string" && step.approval.trim().length > 0) return true;
  if (step.approval && typeof step.approval === "object" && !Array.isArray(step.approval))
    return true;
  return false;
}

function isInputStep(step: WorkflowStep) {
  return Boolean(step.input && typeof step.input === "object" && !Array.isArray(step.input));
}

function stepType(step: WorkflowStep) {
  if (step.parallel) return "parallel";
  if (typeof step.for_each === "string") return "for_each";
  if (typeof step.workflow === "string" && step.workflow.trim()) return "workflow";
  if (typeof step.pipeline === "string" && step.pipeline.trim()) return "pipeline";
  if (typeof step.run === "string" || typeof step.command === "string") return "run";
  if (isApprovalStep(step)) return "approval";
  if (isInputStep(step)) return "input";
  return "step";
}

function stepDetails(step: WorkflowStep, args: Record<string, unknown>) {
  if (step.parallel) {
    return `parallel (${step.parallel.wait ?? "all"})`;
  }
  if (typeof step.for_each === "string") {
    return `for_each: ${resolveArgsTemplate(step.for_each, args)}`;
  }
  if (typeof step.workflow === "string" && step.workflow.trim()) {
    return `workflow: ${resolveArgsTemplate(step.workflow, args)}`;
  }
  if (typeof step.pipeline === "string" && step.pipeline.trim()) {
    return `pipeline: ${resolveArgsTemplate(step.pipeline, args)}`;
  }
  const shell = typeof step.run === "string" ? step.run : step.command;
  if (typeof shell === "string" && shell.trim()) {
    return `run: ${resolveArgsTemplate(shell, args)}`;
  }
  if (isApprovalStep(step)) return "approval gate";
  if (isInputStep(step)) return "input request";
  return "";
}

function extractStepRefsFromString(value: string): string[] {
  const refs = new Set<string>();
  const rx = /\$([A-Za-z0-9_-]+)\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*/g;
  for (const m of value.matchAll(rx)) {
    if (m[1]) refs.add(m[1]);
  }
  return [...refs];
}

function extractStepRefs(value: unknown): string[] {
  if (typeof value === "string") return extractStepRefsFromString(value);
  if (Array.isArray(value)) {
    const refs = new Set<string>();
    for (const item of value) {
      for (const ref of extractStepRefs(item)) refs.add(ref);
    }
    return [...refs];
  }
  if (value && typeof value === "object") {
    const refs = new Set<string>();
    for (const v of Object.values(value as Record<string, unknown>)) {
      for (const ref of extractStepRefs(v)) refs.add(ref);
    }
    return [...refs];
  }
  return [];
}

function truncate(value: string, max = 80) {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function collectGraph(workflow: WorkflowFile, args: Record<string, unknown>) {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const knownStepIds = new Set(workflow.steps.map((s) => s.id));
  let prevStepId: string | null = null;

  const seenEdgeKeys = new Set<string>();
  const addEdge = (edge: GraphEdge) => {
    const key = `${edge.from}|${edge.to}|${edge.label ?? ""}`;
    if (seenEdgeKeys.has(key)) return;
    seenEdgeKeys.add(key);
    edges.push(edge);
  };

  for (const step of workflow.steps) {
    const type = stepType(step);
    const details = stepDetails(step, args);
    const label = details ? `${step.id}\\n${truncate(details)}` : step.id;
    nodes.push({
      id: step.id,
      type,
      label,
      shape: isApprovalStep(step) ? "diamond" : "box",
    });

    if (prevStepId) {
      addEdge({ from: prevStepId, to: step.id, label: "next" });
    }
    prevStepId = step.id;

    for (const ref of extractStepRefs(step.stdin)) {
      if (knownStepIds.has(ref)) addEdge({ from: ref, to: step.id, label: "stdin" });
    }

    if (typeof step.for_each === "string") {
      for (const ref of extractStepRefs(step.for_each)) {
        if (knownStepIds.has(ref)) addEdge({ from: ref, to: step.id, label: "for_each" });
      }
    }

    const condition = step.when ?? step.condition;
    if (typeof condition === "string" && condition.trim()) {
      const labelValue = truncate(`when: ${condition.trim()}`, 70);
      for (const ref of extractStepRefs(condition)) {
        if (knownStepIds.has(ref)) addEdge({ from: ref, to: step.id, label: labelValue });
      }
    }
  }

  return { nodes, edges };
}

function sanitizeMermaidId(id: string) {
  return id.replace(/[^A-Za-z0-9_]/g, "_");
}

function escapeMermaidLabel(value: string) {
  return value.replace(/"/g, '\\"');
}

function renderMermaid(nodes: GraphNode[], edges: GraphEdge[]) {
  const idMap = new Map<string, string>();
  const used = new Set<string>();
  for (const node of nodes) {
    let key = sanitizeMermaidId(node.id) || "step";
    if (/^\d/.test(key)) key = `s_${key}`;
    let i = 2;
    while (used.has(key)) {
      key = `${sanitizeMermaidId(node.id)}_${i}`;
      i += 1;
    }
    used.add(key);
    idMap.set(node.id, key);
  }

  const lines = ["flowchart TD"];
  for (const node of nodes) {
    const key = idMap.get(node.id)!;
    const label = escapeMermaidLabel(node.label);
    if (node.shape === "diamond") {
      lines.push(`  ${key}{"${label}"}`);
    } else {
      lines.push(`  ${key}["${label}"]`);
    }
  }
  if (nodes.length) lines.push("");

  for (const edge of edges) {
    const from = idMap.get(edge.from);
    const to = idMap.get(edge.to);
    if (!from || !to) continue;
    if (edge.label) {
      lines.push(`  ${from} -->|${escapeMermaidLabel(edge.label)}| ${to}`);
    } else {
      lines.push(`  ${from} --> ${to}`);
    }
  }
  return lines.join("\n");
}

function escapeDot(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function renderDot(nodes: GraphNode[], edges: GraphEdge[]) {
  const lines = ["digraph workflow {", "  rankdir=TB;"];
  for (const node of nodes) {
    const shape = node.shape === "diamond" ? "diamond" : "box";
    lines.push(`  "${escapeDot(node.id)}" [shape=${shape},label="${escapeDot(node.label)}"];`);
  }
  if (nodes.length) lines.push("");
  for (const edge of edges) {
    if (edge.label) {
      lines.push(
        `  "${escapeDot(edge.from)}" -> "${escapeDot(edge.to)}" [label="${escapeDot(edge.label)}"];`,
      );
    } else {
      lines.push(`  "${escapeDot(edge.from)}" -> "${escapeDot(edge.to)}";`);
    }
  }
  lines.push("}");
  return lines.join("\n");
}

function renderAscii(nodes: GraphNode[], edges: GraphEdge[]) {
  const lines = ["Workflow Graph", "", "Nodes:"];
  for (const node of nodes) {
    lines.push(
      `- ${node.id} [${node.type}] ${node.label.includes("\\n") ? `(${node.label.split("\\n")[1]})` : ""}`.trim(),
    );
  }
  lines.push("", "Edges:");
  for (const edge of edges) {
    lines.push(`- ${edge.from} -> ${edge.to}${edge.label ? ` (${edge.label})` : ""}`);
  }
  if (edges.length === 0) lines.push("- (none)");
  return lines.join("\n");
}

export function renderWorkflowGraph({ workflow, format, args = {} }: RenderGraphParams) {
  const { nodes, edges } = collectGraph(workflow, args);
  if (format === "dot") return renderDot(nodes, edges);
  if (format === "ascii") return renderAscii(nodes, edges);
  return renderMermaid(nodes, edges);
}
