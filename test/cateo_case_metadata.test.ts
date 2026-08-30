import { describe, expect, it } from "vitest";
import { accumulateConversationMetadata, attachCaseMetadataAndDatasetCandidate } from "../src/cateo/case_metadata.js";
import type { CateoArtifactRecord, CateoCaseRecord } from "../src/cateo/types.js";

describe("conversation-driven case metadata", () => {
  it("accumulates structured facts and observations idempotently across turns", () => {
    const first = accumulateConversationMetadata({
      messageId: "message-1",
      text: "The pump shows error E-441 and I already restarted it.",
      input: { symptomDescription: "Pump temperature alarm", errorCode: "E-441", machine: { model: "Pump X2" } },
      timestamp: "2026-08-29T10:00:00.000Z",
    });
    const retried = accumulateConversationMetadata({
      current: first,
      messageId: "message-1",
      text: "The pump shows error E-441 and I already restarted it.",
      input: { symptomDescription: "Pump temperature alarm", errorCode: "E-441", machine: { model: "Pump X2" } },
      timestamp: "2026-08-29T10:00:01.000Z",
    });
    expect(retried).toBe(first);
    expect(retried.version).toBe(1);
    expect(retried.fields.errorCode.value).toBe("E-441");
    expect(retried.fields.actionsAttempted.value).toEqual(["The pump shows error E-441 and I already restarted it."]);

    const second = accumulateConversationMetadata({
      current: retried,
      messageId: "message-2",
      text: "After that I measured 82 C and it is still failing.",
      input: { symptomDescription: "After that I measured 82 C and it is still failing." },
      timestamp: "2026-08-29T10:01:00.000Z",
    });
    expect(second.fields.observations.value).toEqual([
      "The pump shows error E-441 and I already restarted it.",
      "After that I measured 82 C and it is still failing.",
    ]);
    expect(second.fields.resolutionStatus.value).toBe("UNRESOLVED");
    expect(second.version).toBe(2);
  });

  it("preserves conflicts and asks for clarification until a user correction resolves them", () => {
    const first = accumulateConversationMetadata({
      messageId: "message-a",
      text: "The instrument is an Alinity i.",
      input: { symptomDescription: "No aspiration", machine: { model: "Alinity i" } },
    });
    const conflicted = accumulateConversationMetadata({
      current: first,
      messageId: "message-b",
      text: "The model is Alinity c.",
      input: { symptomDescription: "The model is Alinity c.", machine: { model: "Alinity c" } },
    });
    expect(conflicted.fields.instrument.status).toBe("CONFLICTED");
    expect(conflicted.fields.instrument.conflictingValues).toEqual(["Alinity i", "Alinity c"]);
    expect(conflicted.pendingClarification).toMatch(/which value is correct/i);
    expect(conflicted.pendingClarification).not.toMatch(/instrumentId|errorCode|applicableVersion/);

    const corrected = accumulateConversationMetadata({
      current: conflicted,
      messageId: "message-c",
      text: "Actually, correction: the instrument is Alinity i.",
      input: { symptomDescription: "Correction" },
    });
    expect(corrected.fields.instrument.value).toBe("Alinity i");
    expect(corrected.fields.instrument.status).toBe("CONFIRMED");
    expect(corrected.fields.instrument.source).toBe("USER_CORRECTED");
    expect(corrected.fields.instrument.correctionHistory.length).toBeGreaterThan(0);
    expect(corrected.pendingClarification).toBeUndefined();
    expect(corrected.fields.symptom.value).toBe("No aspiration");
  });

  it("classifies negative outcomes before positive wording", () => {
    const metadata = accumulateConversationMetadata({
      messageId: "message-outcome",
      text: "It is not resolved; the instrument is still failing.",
      input: { symptomDescription: "Intermittent pressure" },
    });
    expect(metadata.fields.resolutionStatus.value).toBe("UNRESOLVED");
  });

  it("does not mistake an analyzer action for an instrument model", () => {
    const first = accumulateConversationMetadata({
      messageId: "message-action",
      text: "The analyzer stopped during startup and shows error E42.",
      input: { symptomDescription: "The analyzer stopped during startup and shows error E42." },
    });
    expect(first.fields.instrument).toBeUndefined();

    const second = accumulateConversationMetadata({
      current: first,
      messageId: "message-model",
      text: "The label says the instrument is Alinity i, but no part number is visible.",
      input: { symptomDescription: "The label says the instrument is Alinity i, but no part number is visible." },
    });
    expect(second.fields.instrument.value).toBe("Alinity i");
    expect(second.fields.instrument.status).toBe("CONFIRMED");
    expect(second.pendingClarification).toBeUndefined();
  });

  it("lets user-stated evidence supersede inference without erasing history", () => {
    const current = {
      schemaVersion: "cateo-dynamic-case-metadata-v1" as const,
      version: 1,
      updatedAt: "2026-08-29T09:00:00.000Z",
      processedMessageIds: ["inference-1"],
      fields: {
        instrument: {
          value: "Inferred Model A",
          status: "PROVISIONAL" as const,
          source: "MODEL_INFERRED" as const,
          sourceMessageId: "inference-1",
          timestamp: "2026-08-29T09:00:00.000Z",
          version: 1,
          confidence: 0.55,
          correctionHistory: [],
        },
      },
    };
    const updated = accumulateConversationMetadata({
      current,
      messageId: "message-user",
      text: "The instrument is Model B.",
      input: { symptomDescription: "No aspiration", machine: { model: "Model B" } },
      timestamp: "2026-08-29T09:01:00.000Z",
    });

    expect(updated.fields.instrument.value).toBe("Model B");
    expect(updated.fields.instrument.source).toBe("USER_STATED");
    expect(updated.fields.instrument.correctionHistory[0]?.value).toBe("Inferred Model A");
  });

  it("adds version and release facts to the internal case while keeping dataset candidacy unreviewed", () => {
    const caseRecord = {
      caseId: "case-1",
      conversationId: "conversation-1",
      releaseControl: {
        schemaVersion: "cateo-release-control-v1",
        policyVersion: "cateo-human-release-policy-v1",
        state: "UNREVIEWED",
        version: 1,
        currentContentHash: "content-hash",
        rejectedContentHashes: [],
        sourceGrounding: { status: "MISSING", sources: [] },
        transitions: [{
          transitionId: "transition-1",
          idempotencyKey: "transition-key",
          actorId: "system",
          actorDisplayName: "Cateo",
          actorRole: "system",
          occurredAt: "2026-08-29T10:00:00.000Z",
          priorState: null,
          newState: "UNREVIEWED",
          reason: "Generated draft",
          contentHash: "content-hash",
          artifactRevisionIds: ["revision-1"],
          policyVersion: "cateo-human-release-policy-v1",
          schemaVersion: "cateo-release-control-v1",
          promptVersion: "prompt-v1",
          retrievalVersion: "retrieval-v1",
          modelVersions: ["model-v1"],
        }],
        processedIdempotencyKeys: ["transition-key"],
      },
    } as unknown as CateoCaseRecord;
    const artifact = {
      revisions: [{ revisionId: "revision-1" }],
    } as unknown as CateoArtifactRecord;

    attachCaseMetadataAndDatasetCandidate({ caseRecord, artifacts: [artifact] });

    expect(caseRecord.dynamicMetadata?.fields.conversationId.value).toBe("conversation-1");
    expect(caseRecord.dynamicMetadata?.fields.generatedInstructionRevisionIds.value).toEqual(["revision-1"]);
    expect(caseRecord.dynamicMetadata?.fields.releaseState.value).toBe("UNREVIEWED");
    expect(caseRecord.dynamicMetadata?.fields.modelVersions.value).toEqual(["model-v1"]);
    expect(caseRecord.datasetCandidate?.state).toBe("UNREVIEWED");
    expect(caseRecord.datasetCandidate?.eligibility).toEqual({ train: false, development: false, test: false });
  });
});
