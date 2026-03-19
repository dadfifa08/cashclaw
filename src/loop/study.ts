import crypto from "node:crypto";
import type { CashClawConfig } from "../config.js";
import type { CateoModelRuntime, CateoRuntimeModelInfo } from "../llm/runtime.js";
import { isCateoModelRuntime } from "../llm/runtime.js";
import type { LLMMessage, LLMProvider } from "../llm/types.js";
import { appendStudySession } from "../memory/datasets.js";
import { loadFeedback, type FeedbackEntry } from "../memory/feedback.js";
import {
  loadKnowledge,
  storeKnowledge,
  type KnowledgeEntry,
} from "../memory/knowledge.js";

export interface StudyResult {
  topic: KnowledgeEntry["topic"];
  insight: string;
  tokensUsed: number;
  model: CateoRuntimeModelInfo;
}

const STUDY_TOPICS: KnowledgeEntry["topic"][] = [
  "feedback_analysis",
  "specialty_research",
  "task_simulation",
  "diagnostic_pattern",
  "procedure_guidance",
];

const MAX_STUDY_TURNS = 3;

type StudyModelInput = LLMProvider | CateoModelRuntime;

function resolveStudyModel(runtime: StudyModelInput, config: CashClawConfig): { llm: LLMProvider; model: CateoRuntimeModelInfo } {
  if (isCateoModelRuntime(runtime)) {
    return {
      llm: runtime.study,
      model: runtime.meta.study,
    };
  }

  return {
    llm: runtime,
    model: {
      role: "study",
      provider: config.llm.provider,
      model: config.llm.model,
      baseUrl: config.llm.baseUrl,
    },
  };
}

function pickTopic(existing: KnowledgeEntry[], feedback: FeedbackEntry[]): KnowledgeEntry["topic"] {
  const eligible = feedback.length > 0
    ? STUDY_TOPICS
    : STUDY_TOPICS.filter((topic) => topic !== "feedback_analysis");

  const counts = new Map<string, number>();
  for (const topic of eligible) counts.set(topic, 0);

  for (const entry of existing) {
    if (eligible.includes(entry.topic)) {
      counts.set(entry.topic, (counts.get(entry.topic) ?? 0) + 1);
    }
  }

  let minTopic = eligible[0];
  let minCount = Infinity;

  for (const topic of eligible) {
    const count = counts.get(topic) ?? 0;
    if (count < minCount) {
      minCount = count;
      minTopic = topic;
    }
  }

  return minTopic;
}

function buildStudyPrompt(
  topic: KnowledgeEntry["topic"],
  config: CashClawConfig,
  feedback: FeedbackEntry[],
  knowledge: KnowledgeEntry[],
): string {
  const specialties = config.specialties.length > 0
    ? config.specialties.join(", ")
    : "general-purpose diagnostics";

  const recentFeedback = feedback.slice(-10);
  const feedbackSummary = recentFeedback.length > 0
    ? recentFeedback
        .map((entry) => `- Score ${entry.score}/5: "${entry.taskDescription}" - ${entry.comments || "no comment"}`)
        .join("\n")
    : "No feedback yet.";

  const existingKnowledge = knowledge.slice(-5)
    .map((entry) => `- [${entry.topic}] ${entry.insight.slice(0, 150)}`)
    .join("\n") || "None yet.";

  const base = `You are Cateo, a self-improving engineering agent specializing in: ${specialties}.
You are conducting a study session to improve future task performance in inspection, troubleshooting, preventive maintenance, documentation, and technical workflow support.

## Existing knowledge
${existingKnowledge}

## Recent client feedback
${feedbackSummary}
`;

  switch (topic) {
    case "feedback_analysis":
      return `${base}
## Study Task: Feedback Analysis

Analyze the feedback patterns above.
Identify:
1. What types of work scored well
2. What types of work scored poorly
3. What recurring mistakes or weaknesses may be present
4. What concrete improvements should be applied to future work

Produce a concise insight with actionable takeaways.`;

    case "specialty_research":
      return `${base}
## Study Task: Specialty Deep-Dive

For the specialties ${specialties}, articulate:
1. Best practices and quality standards
2. Common pitfalls and failure patterns
3. What distinguishes strong work from mediocre work
4. Practical methods to increase reliability and usefulness

Produce a concise insight with concrete, actionable knowledge.`;

    case "task_simulation":
      return `${base}
## Study Task: Practice Simulation

Generate a realistic client request related to ${specialties}.
Then explain:
1. How Cateo should approach the task
2. What evidence or context would matter most
3. What a strong deliverable should include
4. What mistakes should be avoided

Produce a concise insight covering the approach and lessons learned.`;

    case "diagnostic_pattern":
      return `${base}
## Study Task: Diagnostic Pattern Extraction

Identify a realistic technical failure pattern or recurring troubleshooting scenario related to ${specialties}.
Then explain:
1. Typical symptoms
2. Likely root causes
3. Evidence that helps distinguish causes
4. Corrective actions
5. Preventive actions

Produce a concise diagnostic pattern that would improve future technical reasoning.`;

    case "procedure_guidance":
      return `${base}
## Study Task: Procedure and Guidance Improvement

Develop a compact set of guidance for producing stronger technical procedures, checklists, or troubleshooting instructions in the domain of ${specialties}.
Focus on:
1. Clarity
2. Sequence
3. Decision points
4. Safety / risk awareness
5. Common omissions

Produce a concise insight that would help generate better structured deliverables in future tasks.`;

    default: {
      const _exhaustive: never = topic;
      return `${base}
## Study Task

Produce a concise technical insight that improves future work quality.`;
    }
  }
}

function generateId(): string {
  return crypto.randomUUID();
}

export async function runStudySession(
  runtimeInput: StudyModelInput,
  config: CashClawConfig,
): Promise<StudyResult> {
  const resolved = resolveStudyModel(runtimeInput, config);
  const feedback = loadFeedback();
  const knowledge = loadKnowledge();
  const topic = pickTopic(knowledge, feedback);

  const specialtyPool = config.specialties.length > 0 ? config.specialties : ["general"];
  const topicEntries = knowledge.filter((entry) => entry.topic === topic);
  const specialty = specialtyPool[topicEntries.length % specialtyPool.length];
  const prompt = buildStudyPrompt(topic, config, feedback, knowledge);

  const messages: LLMMessage[] = [
    { role: "user", content: prompt },
  ];

  let totalTokens = 0;
  let lastText = "";

  for (let turn = 0; turn < MAX_STUDY_TURNS; turn += 1) {
    const response = await resolved.llm.chat(messages);
    totalTokens += response.usage.inputTokens + response.usage.outputTokens;

    const textBlocks = response.content.filter(
      (block): block is { type: "text"; text: string } => block.type === "text",
    );
    lastText = textBlocks.map((block) => block.text).join("\n");

    if (response.stopReason === "end_turn") break;

    messages.push({ role: "assistant", content: response.content });
    messages.push({
      role: "user",
      content: "Continue your analysis. Focus on the most actionable insight.",
    });
  }

  const insight = lastText.trim() || "No insight produced.";

  const source = topic === "feedback_analysis" && feedback.length > 0
    ? `${feedback.length} feedback entries (avg ${(feedback.reduce((sum, entry) => sum + entry.score, 0) / feedback.length).toFixed(1)}/5)`
    : `scheduled ${topic} session`;

  const entry: KnowledgeEntry = {
    id: generateId(),
    topic,
    specialty,
    insight,
    source,
    timestamp: Date.now(),
  };

  storeKnowledge(entry);

  appendStudySession({
    schemaVersion: "1.0",
    kind: "study_session",
    timestamp: entry.timestamp,
    topic,
    specialty,
    insight,
    source,
    tokensUsed: totalTokens,
    modelProvider: resolved.model.provider,
    modelName: resolved.model.model,
  });

  return { topic, insight, tokensUsed: totalTokens, model: resolved.model };
}
