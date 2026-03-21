import type { CashClawConfig } from "../config.js";
import { appendAuditEvent } from "../security/audit.js";
import type { CateoAssistInput } from "./types.js";

interface VisionPayload { title_hint?: string; observed_conditions?: string[]; visible_components?: string[]; relevant_markings?: string[]; safety_signals?: string[]; follow_up_measurements?: string[]; }
const unique = (values: Array<string | undefined | null>) => [...new Set(values.map((v) => v?.trim()).filter((v): v is string => Boolean(v)))];
const canUse = (config: CashClawConfig) => config.llm.provider === "openai" && Boolean(config.llm.apiKey);
const model = (config: CashClawConfig) => config.pilot?.hostedRoleModels?.lead?.trim() || config.llm.model || "gpt-4.1-mini";
const parse = (raw?: string | null) => { if (!raw) return null; try { return JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "")) as VisionPayload; } catch { return null; } };
const dataUrl = (mime: string | undefined, b64: string) => `data:${mime?.trim() || "application/octet-stream"};base64,${b64}`;

export async function enrichAssistInputWithOpenAIMedia(config: CashClawConfig, input: CateoAssistInput, requestId?: string): Promise<{ input: CateoAssistInput; mediaInsights: string[] }> {
  const textInsights = (input.attachments ?? []).filter((a) => a.contentBase64 && (!a.mimeType || a.mimeType.startsWith("text/") || a.mimeType === "application/json")).map((a) => { const text = Buffer.from(a.contentBase64 ?? "", "base64").toString("utf8").replace(/\s+/g, " ").trim(); return text ? `Attachment ${a.name} excerpt: ${text.slice(0, 480)}` : undefined; }).filter((v): v is string => Boolean(v));
  const images = (input.attachments ?? []).filter((a) => a.contentBase64 && (a.kind === "image" || a.mimeType?.startsWith("image/")));
  if (!canUse(config) || images.length === 0) return { input: textInsights.length ? { ...input, observedConditions: unique([...(input.observedConditions ?? []), ...textInsights]) } : input, mediaInsights: textInsights };
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.llm.apiKey}` }, body: JSON.stringify({ model: model(config), response_format: { type: "json_object" }, max_completion_tokens: 700, messages: [{ role: "user", content: [{ type: "text", text: ["You are analyzing engineering evidence for Cateo.", "Return strict JSON with keys: title_hint, observed_conditions, visible_components, relevant_markings, safety_signals, follow_up_measurements.", "Keep everything concise and visually grounded.", input.errorCode ? `Reported error code: ${input.errorCode}` : "", `Prompt: ${input.symptomDescription}`].filter(Boolean).join("\n") }, ...images.slice(0, 4).map((a) => ({ type: "image_url", image_url: { url: dataUrl(a.mimeType, a.contentBase64 ?? "") } }))] }] }) });
    if (!response.ok) throw new Error(`OpenAI media analysis failed: ${response.status} ${await response.text()}`);
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string | null } }> };
    const parsed = parse(payload.choices?.[0]?.message?.content);
    const insights = unique([...(parsed?.observed_conditions ?? []), ...(parsed?.visible_components ?? []).map((v) => `Visible component: ${v}`), ...(parsed?.relevant_markings ?? []).map((v) => `Visible marking: ${v}`), ...(parsed?.safety_signals ?? []).map((v) => `Safety signal: ${v}`), ...(parsed?.follow_up_measurements ?? []).map((v) => `Suggested measurement: ${v}`), ...textInsights]);
    appendAuditEvent({ actor: "runtime", category: "cateo_media", action: "openai_image_analysis", outcome: "success", message: `OpenAI analyzed ${images.length} image attachment(s) for Cateo input enrichment`, requestId, metadata: { attachmentCount: images.length, model: model(config) } });
    return { input: { ...input, title: input.title || parsed?.title_hint || input.title, observedConditions: unique([...(input.observedConditions ?? []), ...insights]) }, mediaInsights: insights };
  } catch (error) {
    appendAuditEvent({ actor: "runtime", category: "cateo_media", action: "openai_image_analysis", outcome: "failed", severity: "warn", message: error instanceof Error ? error.message : "OpenAI media analysis failed", requestId, metadata: { attachmentCount: images.length } });
    return { input: { ...input, observedConditions: unique([...(input.observedConditions ?? []), ...textInsights]) }, mediaInsights: textInsights };
  }
}

export async function transcribeAudioWithOpenAI(config: CashClawConfig, args: { mimeType?: string; name?: string; contentBase64: string; requesterId?: string }, requestId?: string): Promise<{ text: string; model: string }> {
  if (!canUse(config)) throw new Error("OpenAI-backed transcription is not enabled for this Cateo runtime.");
  const models = unique([process.env.CATEO_AUDIO_TRANSCRIBE_MODEL, "gpt-4o-mini-transcribe", "whisper-1"]);
  const buffer = Buffer.from(args.contentBase64, "base64");
  let lastError: unknown = null;
  for (const currentModel of models) {
    try {
      const form = new FormData();
      form.set("model", currentModel);
      form.set("file", new Blob([buffer], { type: args.mimeType?.trim() || "audio/webm" }), args.name?.trim() || "cateo-audio.webm");
      form.set("prompt", "Transcribe this recording for an engineering troubleshooting and inspection workflow. Preserve part numbers, error codes, measurements, and acronyms.");
      const response = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${config.llm.apiKey}` }, body: form });
      if (!response.ok) throw new Error(`OpenAI transcription failed for ${currentModel}: ${response.status} ${await response.text()}`);
      const payload = await response.json() as { text?: string };
      const text = payload.text?.trim();
      if (!text) throw new Error(`OpenAI transcription returned no text for ${currentModel}`);
      appendAuditEvent({ actor: "server", category: "public_audio", action: "transcribe", outcome: "success", message: `Transcribed public audio input with ${currentModel}`, requestId, metadata: { requesterId: args.requesterId, model: currentModel, bytes: buffer.length } });
      return { text, model: currentModel };
    } catch (error) { lastError = error; }
  }
  appendAuditEvent({ actor: "server", category: "public_audio", action: "transcribe", outcome: "failed", severity: "warn", message: lastError instanceof Error ? lastError.message : "OpenAI transcription failed", requestId, metadata: { requesterId: args.requesterId, bytes: buffer.length } });
  throw lastError instanceof Error ? lastError : new Error("OpenAI transcription failed");
}

