import fs from "node:fs";
import path from "node:path";
import { getConfigDir } from "../config.js";

const DEFAULT_RULES_DOCUMENT = `# Cateo V1 Troubleshooting Output Rules

## Objective
Produce one controlled troubleshooting report package per request. The customer sees a concise conversational answer, but the underlying procedure must remain engineering-grade, deterministic where possible, and reusable as a dataset artifact.

## Required report sections
1. Document control
2. Transparency and AI-generation notice
3. Problem definition and fault area
4. System, part, and operating-domain identification
5. Prework, hazards, and readiness checks
6. Observed conditions and grounded evidence summary
7. Numbered troubleshooting steps with rationale and expected results
8. Expected values, pass criteria, escalation triggers, and failure paths
9. Probable root cause and confidence
10. Validation steps, release criteria, and recurrence controls
11. Parts, tools, and references

## Output rules
- Prefer troubleshooting procedures, diagnostic reasoning, service summaries, and parts/tools data over general prose.
- Use explicit values, ranges, thresholds, or pass-fail criteria whenever the evidence supports them.
- If the manufacturer part number is uncertain, ask a clarifying question instead of inventing the identity.
- Every step must include why the step matters and what result is expected.
- When evidence supports it, include prework, required tools, required parts, fault-area framing, and explicit validation steps in customer-facing language.
- Root-cause statements must be bounded by confidence and supporting evidence.
- Separate verified findings from assumptions.
- Reference attachments, prior service history, and verified sources when they materially influence the recommendation.
- If warnings, hazards, lockout requirements, PPE notes, or other safety labels are available, include them explicitly in the troubleshooting output.
- Keep customer-facing language readable, but never drop the controlled procedure structure in the stored report package.

## Prohibited behavior
- Do not fabricate expected values, specs, part numbers, or service history.
- Do not recommend return to service without a verification step.
- Do not hide uncertainty.
- Do not emit marketing copy in the report body.
`;

export interface CateoRulesDocument {
  path: string;
  content: string;
}

export function getTroubleshootingRulesDocumentPath(): string {
  return path.join(getConfigDir(), "cateo", "templates", "troubleshooting-rules.md");
}

export function loadTroubleshootingRulesDocument(): CateoRulesDocument {
  const filePath = getTroubleshootingRulesDocumentPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, DEFAULT_RULES_DOCUMENT, { encoding: "utf8", mode: 0o600 });
  }

  const content = fs.readFileSync(filePath, "utf8").trim() || DEFAULT_RULES_DOCUMENT.trim();
  return {
    path: filePath,
    content,
  };
}
