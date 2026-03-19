import type { Task } from "../../moltlaunch/types.js";

function inferTaskType(task: Task): string {
  const text = [
    task.task ?? "",
    task.category ?? "",
    ...(task.messages?.map((m) => m.content) ?? []),
    ...(task.files?.map((f) => f.name) ?? []),
  ]
    .join(" ")
    .toLowerCase();

  if (text.match(/inspect|inspection|checklist|audit|verify|validation/)) {
    return "inspection";
  }
  if (text.match(/troubleshoot|diagnos|error|fault|failure|issue|problem|root cause|rca/)) {
    return "troubleshooting";
  }
  if (text.match(/preventive|maintenance|pm|service interval|routine/)) {
    return "preventive_maintenance";
  }
  if (text.match(/sop|procedure|work instruction|manual|documentation|doc|guide/)) {
    return "documentation";
  }
  if (text.match(/workflow|process|handoff|triage|escalation/)) {
    return "workflow_support";
  }

  return "general_technical";
}

function requiredAction(task: Task): string {
  switch (task.status) {
    case "requested":
      return "Evaluate fit, ambiguity, and complexity. Then quote, decline, or ask a focused clarification question.";
    case "accepted":
      return "Do the work and prepare a complete, structured deliverable for submission.";
    case "revision":
      return "Incorporate client feedback, preserve valid prior work, and submit a revised deliverable.";
    case "quoted":
      return "Await client response. No major action unless new information appears.";
    case "submitted":
      return "Await review. No major action unless client sends feedback.";
    case "completed":
      return "No action required.";
    default:
      return "Assess the task state and choose the most appropriate next action.";
  }
}

function diagnosticFocus(taskType: string): string {
  switch (taskType) {
    case "inspection":
      return "Focus on inspection scope, criteria, findings, deviations, evidence, and recommended actions.";
    case "troubleshooting":
      return "Focus on symptoms, likely causes, evidence, root-cause hypotheses, tests, corrective actions, and preventive actions.";
    case "preventive_maintenance":
      return "Focus on service intervals, condition indicators, risk prevention, maintenance actions, and follow-up recommendations.";
    case "documentation":
      return "Focus on clarity, structure, procedure quality, completeness, assumptions, and improvement opportunities.";
    case "workflow_support":
      return "Focus on process bottlenecks, handoffs, decision logic, escalation criteria, and operational guidance.";
    default:
      return "Focus on technical clarity, evidence, actionable guidance, and structured outputs.";
  }
}

export function buildTaskPacket(task: Task): string {
  const taskType = inferTaskType(task);
  const parts: string[] = [
    "## Cateo Work Brief",
    "",
    "### Core Task Metadata",
    `- Task ID: ${task.id}`,
    `- Current Status: ${task.status}`,
    `- Inferred Task Type: ${taskType}`,
    `- Client Address: ${task.clientAddress}`,
  ];

  if (task.category) {
    parts.push(`- Marketplace Category: ${task.category}`);
  }

  if (task.budgetWei) {
    parts.push(`- Client Budget (wei): ${task.budgetWei}`);
  }

  if (task.quotedPriceWei) {
    parts.push(`- Current Quoted Price (wei): ${task.quotedPriceWei}`);
  }

  if (task.revisionCount && task.revisionCount > 0) {
    parts.push(`- Revision Count: ${task.revisionCount}`);
  }

  parts.push(
    "",
    "### Client Request",
    task.task || "(No task description provided)",
    "",
    "### Required Action Now",
    requiredAction(task),
    "",
    "### Diagnostic / Work Focus",
    diagnosticFocus(taskType),
  );

  if (task.messages && task.messages.length > 0) {
    const recent = task.messages.slice(-8);
    parts.push("", "### Recent Messages");
    for (const m of recent) {
      parts.push(`- [${m.role}] ${m.content}`);
    }
  }

  if (task.result) {
    parts.push(
      "",
      "### Previous Submission",
      task.result,
    );
  }

  if (task.files && task.files.length > 0) {
    parts.push("", "### Attached Files");
    for (const f of task.files) {
      parts.push(`- ${f.name} (${f.size} bytes)`);
    }
  }

  parts.push(
    "",
    "### Output Expectations",
    "- Be concrete and evidence-oriented.",
    "- Distinguish facts, assumptions, and recommendations.",
    "- Prefer structured technical deliverables over generic prose.",
    "- If key information is missing, ask concise clarification questions before making unsupported claims.",
  );

  return parts.join("\n");
}