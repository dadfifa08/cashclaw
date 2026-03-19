import type { Tool } from "./types.js";
import * as cli from "../moltlaunch/cli.js";

function requireString(input: Record<string, unknown>, key: string): string {
  const val = input[key];
  if (typeof val !== "string" || !val) throw new Error(`Missing required field: ${key}`);
  return val;
}

function looksStructuredDeliverable(text: string): boolean {
  const lower = text.toLowerCase();
  const markers = [
    "task summary",
    "problem statement",
    "evidence reviewed",
    "diagnostic assessment",
    "likely root causes",
    "corrective actions",
    "preventive actions",
    "final recommendation",
    "inspection scope",
    "findings",
    "deviations",
    "procedure purpose",
    "procedure guidance",
  ];
  return markers.some((m) => lower.includes(m));
}

function inferDeliverableType(text: string): "troubleshooting" | "inspection" | "documentation" | "general" {
  const lower = text.toLowerCase();

  if (/(symptom|fault|failure|error|root cause|cause|corrective action|preventive action|diagnostic)/.test(lower)) {
    return "troubleshooting";
  }
  if (/(inspection|criteria|finding|findings|deviation|pass\/fail|acceptance)/.test(lower)) {
    return "inspection";
  }
  if (/(procedure|work instruction|sop|documentation|checklist|guidance|steps)/.test(lower)) {
    return "documentation";
  }
  return "general";
}

function isRevisionSubmission(text: string): boolean {
  const lower = text.toLowerCase();
  return /(revision|updated deliverable|changes made|feedback addressed|revised)/.test(lower);
}

function formatTroubleshootingDeliverable(raw: string): string {
  return [
    "# Cateo Deliverable",
    "",
    "## Task Summary",
    "Troubleshooting analysis completed through the Cateo workflow.",
    "",
    "## Problem Statement",
    "Technical issue assessed based on the provided task context.",
    "",
    "## Evidence Reviewed",
    "- Task description and available task context",
    "- Relevant message history and supplied inputs",
    "",
    "## Diagnostic Assessment",
    raw.trim(),
    "",
    "## Likely Root Causes",
    "- See diagnostic assessment above for the most likely failure mechanisms or contributing factors.",
    "",
    "## Corrective Actions",
    "- Apply the recommended corrective next steps based on the assessment above.",
    "",
    "## Preventive Actions",
    "- Add monitoring, maintenance, documentation, or procedural controls to reduce recurrence.",
    "",
    "## Final Recommendation",
    "Use the troubleshooting assessment above as the working technical recommendation.",
  ].join("\n");
}

function formatInspectionDeliverable(raw: string): string {
  return [
    "# Cateo Deliverable",
    "",
    "## Task Summary",
    "Inspection-oriented review completed through the Cateo workflow.",
    "",
    "## Inspection Scope",
    "Assessment based on the available task description, context, and supplied evidence.",
    "",
    "## Inspection Criteria",
    "- Evaluate conformance, deviations, observable issues, and required follow-up actions.",
    "",
    "## Findings",
    raw.trim(),
    "",
    "## Deviations / Risks",
    "- Review the findings above for any nonconformities, concerns, or open risks.",
    "",
    "## Recommended Actions",
    "- Address deviations, document outcomes, and perform follow-up inspection where needed.",
    "",
    "## Final Recommendation",
    "Use the inspection findings above as the working technical deliverable.",
  ].join("\n");
}

function formatDocumentationDeliverable(raw: string): string {
  return [
    "# Cateo Deliverable",
    "",
    "## Task Summary",
    "Procedure or documentation support completed through the Cateo workflow.",
    "",
    "## Procedure Purpose",
    "This deliverable is intended to improve technical clarity, consistency, and execution quality.",
    "",
    "## Procedure Guidance",
    raw.trim(),
    "",
    "## Risks / Common Omissions",
    "- Validate sequence, assumptions, decision points, and safety or quality implications.",
    "",
    "## Recommended Follow-Up",
    "- Review for completeness, perform stakeholder validation, and revise if additional context becomes available.",
    "",
    "## Final Recommendation",
    "Use the guidance above as the working structured procedure or documentation draft.",
  ].join("\n");
}

function formatGeneralDeliverable(raw: string): string {
  return [
    "# Cateo Deliverable",
    "",
    "## Task Summary",
    "Technical task completed through the Cateo workflow.",
    "",
    "## Problem Statement",
    "See analysis below.",
    "",
    "## Evidence Reviewed",
    "- Task description and available task context",
    "- Relevant message history and supplied inputs",
    "",
    "## Technical Assessment",
    raw.trim(),
    "",
    "## Recommended Actions",
    "- Review the assessment above and apply the recommended next steps.",
    "",
    "## Final Recommendation",
    "Use the structured assessment above as the working technical deliverable.",
  ].join("\n");
}

function formatCateoDeliverable(raw: string): string {
  const text = raw.trim();
  if (!text) return text;
  if (looksStructuredDeliverable(text)) return text;

  const revisionPrefix = isRevisionSubmission(text)
    ? [
        "# Cateo Revised Deliverable",
        "",
        "## Revision Note",
        "This submission incorporates requested changes and preserves valid prior work where applicable.",
        "",
      ].join("\n")
    : "";

  const deliverableType = inferDeliverableType(text);

  let body: string;
  switch (deliverableType) {
    case "troubleshooting":
      body = formatTroubleshootingDeliverable(text);
      break;
    case "inspection":
      body = formatInspectionDeliverable(text);
      break;
    case "documentation":
      body = formatDocumentationDeliverable(text);
      break;
    default:
      body = formatGeneralDeliverable(text);
      break;
  }

  return revisionPrefix ? `${revisionPrefix}\n${body}` : body;
}

export const readTask: Tool = {
  definition: {
    name: "read_task",
    description: "Get full technical task details including status, prior messages, files, previous submissions, and client feedback before taking action.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task ID to read" },
      },
      required: ["task_id"],
    },
  },
  async execute(input) {
    const taskId = requireString(input, "task_id");
    const task = await cli.getTask(taskId);
    return { success: true, data: JSON.stringify(task) };
  },
};

export const quoteTask: Tool = {
  definition: {
    name: "quote_task",
    description: "Submit a price quote for a task in ETH. Use this only when the task fits Cateo's engineering and troubleshooting specialties. Include a concise message describing scope, technical approach, and expected deliverable.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task ID to quote" },
        price_eth: { type: "string", description: "Price in ETH (for example '0.005')" },
        message: { type: "string", description: "Short client-facing note describing fit, scope, and approach" },
      },
      required: ["task_id", "price_eth"],
    },
  },
  async execute(input) {
    const taskId = requireString(input, "task_id");
    const priceEth = requireString(input, "price_eth");
    await cli.quoteTask(taskId, priceEth, input.message as string | undefined);
    return { success: true, data: `Quoted task ${taskId} at ${priceEth} ETH` };
  },
};

export const declineTask: Tool = {
  definition: {
    name: "decline_task",
    description: "Decline a task when it is outside scope, unsafe, too ambiguous to price responsibly, or mismatched to Cateo's technical specialties. Include a concise professional reason when helpful.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task ID to decline" },
        reason: { type: "string", description: "Optional concise reason for declining" },
      },
      required: ["task_id"],
    },
  },
  async execute(input) {
    const taskId = requireString(input, "task_id");
    await cli.declineTask(taskId, input.reason as string | undefined);
    return { success: true, data: `Declined task ${taskId}` };
  },
};

export const submitWork: Tool = {
  definition: {
    name: "submit_work",
    description: "Submit the final deliverable for a task. Deliverables should be complete, polished, and technically structured when appropriate, such as an inspection summary, troubleshooting analysis, root-cause assessment, corrective actions, preventive actions, procedure draft, checklist, or technical write-up.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task ID to submit work for" },
        result: { type: "string", description: "The full final deliverable to send to the client" },
      },
      required: ["task_id", "result"],
    },
  },
  async execute(input) {
    const taskId = requireString(input, "task_id");
    const result = requireString(input, "result");
    const formatted = formatCateoDeliverable(result);
    await cli.submitWork(taskId, formatted);
    return { success: true, data: `Submitted work for task ${taskId}` };
  },
};

export const sendMessage: Tool = {
  definition: {
    name: "send_message",
    description: "Send a concise client-facing message on the task thread. Use this to ask focused clarification questions, communicate technical assumptions, or provide short status updates without overexplaining.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task ID" },
        content: { type: "string", description: "Message content" },
      },
      required: ["task_id", "content"],
    },
  },
  async execute(input) {
    const taskId = requireString(input, "task_id");
    const content = requireString(input, "content");
    await cli.sendMessage(taskId, content);
    return { success: true, data: `Message sent on task ${taskId}` };
  },
};

export const listBounties: Tool = {
  definition: {
    name: "list_bounties",
    description: "Browse open marketplace bounties. Use this to find opportunities that match Cateo's strengths in inspection, troubleshooting, preventive maintenance, technical documentation, and engineering workflow support.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  async execute() {
    const bounties = await cli.getBounties();
    return { success: true, data: JSON.stringify(bounties) };
  },
};

export const claimBounty: Tool = {
  definition: {
    name: "claim_bounty",
    description: "Claim an open bounty when it strongly matches Cateo's domain fit. Include a short message explaining the relevant technical fit and expected quality of deliverable.",
    input_schema: {
      type: "object",
      properties: {
        bounty_id: { type: "string", description: "The bounty ID to claim" },
        message: { type: "string", description: "Short client-facing note on why Cateo is a strong fit" },
      },
      required: ["bounty_id"],
    },
  },
  async execute(input) {
    const bountyId = requireString(input, "bounty_id");
    await cli.claimBounty(bountyId, input.message as string | undefined);
    return { success: true, data: `Claimed bounty ${bountyId}` };
  },
};
