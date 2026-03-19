import { useEffect, useState } from "react";
import { api, type AgentCashAccessClass, type AgentInfo, type ConfigData, type PersonalityData } from "../lib/api.js";
import { ethToUsd, usdToEth } from "../lib/ethPrice.js";

interface FormState {
  specialties: string;
  declineKeywords: string;
  strategy: string;
  baseRate: string;
  maxRate: string;
  maxTasks: number;
  autoQuote: boolean;
  autoWork: boolean;
  learningEnabled: boolean;
  agentCashEnabled: boolean;
  tone: PersonalityData["tone"];
  responseStyle: PersonalityData["responseStyle"];
  customInstructions: string;
  studyIntervalMin: number;
  pollIntervalSec: number;
  urgentPollIntervalSec: number;
  llmProvider: string;
  llmModel: string;
  llmApiKey: string;
  llmBaseUrl: string;
  approvalQuotes: boolean;
  approvalDeclines: boolean;
  approvalClientMessages: boolean;
  approvalSubmissions: boolean;
  approvalBountyClaims: boolean;
  approvalAgentCash: boolean;
  persistOperatorChat: boolean;
  persistKnowledge: boolean;
  persistFeedback: boolean;
  persistDatasets: boolean;
  persistActivityLog: boolean;
  auditRetentionDays: number;
  agentCashMaxUsdPerCall: number;
  agentCashMaxUsdPerTask: number;
  agentCashResearch: boolean;
  agentCashSocial: boolean;
  agentCashMedia: boolean;
  agentCashOutbound: boolean;
}

function hydrateForm(config: ConfigData, ethPrice = 0): FormState {
  return {
    specialties: config.specialties.join(", "),
    declineKeywords: config.declineKeywords.join(", "),
    strategy: config.pricing.strategy,
    baseRate: ethPrice > 0 ? ethToUsd(config.pricing.baseRateEth, ethPrice) : config.pricing.baseRateEth,
    maxRate: ethPrice > 0 ? ethToUsd(config.pricing.maxRateEth, ethPrice) : config.pricing.maxRateEth,
    maxTasks: config.maxConcurrentTasks,
    autoQuote: config.autoQuote,
    autoWork: config.autoWork,
    learningEnabled: config.learningEnabled,
    agentCashEnabled: config.agentCashEnabled ?? false,
    tone: config.personality?.tone ?? "professional",
    responseStyle: config.personality?.responseStyle ?? "concise",
    customInstructions: config.personality?.customInstructions ?? "",
    studyIntervalMin: Math.round(config.studyIntervalMs / 60000),
    pollIntervalSec: Math.round(config.polling.intervalMs / 1000),
    urgentPollIntervalSec: Math.round(config.polling.urgentIntervalMs / 1000),
    llmProvider: config.llm.provider,
    llmModel: config.llm.model,
    llmApiKey: config.llm.apiKey ?? "",
    llmBaseUrl: config.llm.baseUrl ?? "http://localhost:11434/v1",
    approvalQuotes: config.security.approvalPolicy.quotes,
    approvalDeclines: config.security.approvalPolicy.declines,
    approvalClientMessages: config.security.approvalPolicy.clientMessages,
    approvalSubmissions: config.security.approvalPolicy.submissions,
    approvalBountyClaims: config.security.approvalPolicy.bountyClaims,
    approvalAgentCash: config.security.approvalPolicy.agentCash,
    persistOperatorChat: config.security.persistence.persistOperatorChat,
    persistKnowledge: config.security.persistence.persistKnowledge,
    persistFeedback: config.security.persistence.persistFeedback,
    persistDatasets: config.security.persistence.persistDatasets,
    persistActivityLog: config.security.persistence.persistActivityLog,
    auditRetentionDays: config.security.persistence.auditRetentionDays,
    agentCashMaxUsdPerCall: config.security.agentCashPolicy.maxUsdPerCall,
    agentCashMaxUsdPerTask: config.security.agentCashPolicy.maxUsdPerTask,
    agentCashResearch: config.security.agentCashPolicy.allowedClasses.includes("research"),
    agentCashSocial: config.security.agentCashPolicy.allowedClasses.includes("social"),
    agentCashMedia: config.security.agentCashPolicy.allowedClasses.includes("media"),
    agentCashOutbound: config.security.agentCashPolicy.allowedClasses.includes("outbound"),
  };
}

function selectedAgentCashClasses(form: FormState): AgentCashAccessClass[] {
  return [
    form.agentCashResearch ? "research" : null,
    form.agentCashSocial ? "social" : null,
    form.agentCashMedia ? "media" : null,
    form.agentCashOutbound ? "outbound" : null,
  ].filter(Boolean) as AgentCashAccessClass[];
}

export function Settings() {
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [llmTesting, setLlmTesting] = useState(false);
  const [llmTestResult, setLlmTestResult] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ethPrice, setEthPrice] = useState<number>(0);

  useEffect(() => {
    let active = true;
    void Promise.allSettled([api.getConfig(), api.getEthPrice(), api.getAgentInfo()]).then((results) => {
      if (!active) return;
      const configResult = results[0];
      const ethResult = results[1];
      const agentResult = results[2];
      if (configResult.status !== "fulfilled") {
        setLoadError(configResult.reason instanceof Error ? configResult.reason.message : "Failed to load config");
        return;
      }
      const nextConfig = configResult.value;
      const price = ethResult.status === "fulfilled" ? ethResult.value.price : 0;
      setConfig(nextConfig);
      setEthPrice(price);
      setForm(hydrateForm(nextConfig, price));
      if (agentResult.status === "fulfilled") {
        setAgentInfo(agentResult.value.agent);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => current ? { ...current, [key]: value } : current);
  }

  async function save() {
    if (!form || !config) return;
    setSaving(true);
    setMessage("");

    try {
      const isOllama = form.llmProvider === "ollama";
      const hasRealKey = form.llmApiKey !== "***" && form.llmApiKey.trim() !== "";
      const llmChanged =
        form.llmProvider !== config.llm.provider ||
        form.llmModel !== config.llm.model ||
        form.llmBaseUrl !== (config.llm.baseUrl ?? "http://localhost:11434/v1") ||
        (!isOllama && hasRealKey && form.llmApiKey !== config.llm.apiKey);

      const llmUpdate = llmChanged
        ? {
            llm: {
              provider: form.llmProvider,
              model: form.llmModel,
              apiKey: isOllama ? undefined : (hasRealKey ? form.llmApiKey : "***"),
              baseUrl: isOllama ? form.llmBaseUrl : undefined,
            },
          }
        : {};

      const baseEth = ethPrice > 0 ? usdToEth(parseFloat(form.baseRate) || 0, ethPrice) : form.baseRate;
      const maxEth = ethPrice > 0 ? usdToEth(parseFloat(form.maxRate) || 0, ethPrice) : form.maxRate;

      await api.updateConfig({
        specialties: form.specialties.split(",").map((entry) => entry.trim()).filter(Boolean),
        declineKeywords: form.declineKeywords.split(",").map((entry) => entry.trim()).filter(Boolean),
        pricing: { strategy: form.strategy, baseRateEth: baseEth, maxRateEth: maxEth },
        autoQuote: form.autoQuote,
        autoWork: form.autoWork,
        maxConcurrentTasks: form.maxTasks,
        learningEnabled: form.learningEnabled,
        agentCashEnabled: form.agentCashEnabled,
        personality: {
          tone: form.tone,
          responseStyle: form.responseStyle,
          customInstructions: form.customInstructions || undefined,
        },
        studyIntervalMs: form.studyIntervalMin * 60000,
        polling: {
          intervalMs: form.pollIntervalSec * 1000,
          urgentIntervalMs: form.urgentPollIntervalSec * 1000,
        },
        security: {
          approvalPolicy: {
            quotes: form.approvalQuotes,
            declines: form.approvalDeclines,
            clientMessages: form.approvalClientMessages,
            submissions: form.approvalSubmissions,
            bountyClaims: form.approvalBountyClaims,
            agentCash: form.approvalAgentCash,
          },
          persistence: {
            persistOperatorChat: form.persistOperatorChat,
            persistKnowledge: form.persistKnowledge,
            persistFeedback: form.persistFeedback,
            persistDatasets: form.persistDatasets,
            persistActivityLog: form.persistActivityLog,
            auditRetentionDays: form.auditRetentionDays,
          },
          agentCashPolicy: {
            maxUsdPerCall: form.agentCashMaxUsdPerCall,
            maxUsdPerTask: form.agentCashMaxUsdPerTask,
            allowedClasses: selectedAgentCashClasses(form),
          },
        },
        ...llmUpdate,
      });

      const fresh = await api.getConfig();
      setConfig(fresh);
      setForm(hydrateForm(fresh, ethPrice));
      setMessage("SAVED");
      setTimeout(() => setMessage(""), 2000);
    } catch (err) {
      setMessage(err instanceof Error ? `FAILED: ${err.message}` : "FAILED");
    } finally {
      setSaving(false);
    }
  }

  async function testLlm() {
    if (!form) return;
    setLlmTesting(true);
    setLlmTestResult("");

    try {
      const isOllama = form.llmProvider === "ollama";
      const result = await api.testLLM({
        provider: form.llmProvider,
        model: form.llmModel,
        apiKey: isOllama ? undefined : (form.llmApiKey === "***" ? config?.llm.apiKey ?? "" : form.llmApiKey),
        baseUrl: isOllama ? form.llmBaseUrl : undefined,
      });
      setLlmTestResult(result.response);
    } catch (err) {
      setLlmTestResult(err instanceof Error ? err.message : "Test failed");
    } finally {
      setLlmTesting(false);
    }
  }

  if (loadError) {
    return (
      <div className="text-center py-32">
        <p className="text-sm text-red-400 mb-2">Failed to load settings</p>
        <p className="text-xs text-zinc-600 font-mono">{loadError}</p>
      </div>
    );
  }

  if (!config || !form) {
    return (
      <div className="text-center py-32">
        <div className="w-5 h-5 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin mx-auto mb-3" />
        <p className="text-sm text-zinc-600">Loading...</p>
      </div>
    );
  }

  const isOllama = form.llmProvider === "ollama";

  return (
    <div className="space-y-6 pb-24">
      <div>
        <h1 className="text-3xl font-bold text-zinc-100 tracking-tight mb-1.5">Runtime Settings</h1>
        <p className="text-sm text-zinc-500">Configure Cateo runtime behavior, security policy, retention, model routing, and operator controls.</p>
      </div>

      <Section title="Agent Identity">
        <div className="flex items-start justify-between gap-6">
          <div className="flex items-center gap-4 min-w-0">
            <div className="w-12 h-12 rounded-lg bg-zinc-800 border border-zinc-700/50 flex items-center justify-center shrink-0">
              <span className="text-zinc-300 text-xl font-bold">{(agentInfo?.name ?? config.agentId)?.[0]?.toUpperCase() ?? "?"}</span>
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-bold text-zinc-200 truncate tracking-tight">{agentInfo?.name ?? config.agentId}</h2>
              {agentInfo?.description && <p className="text-[13px] text-zinc-500 truncate">{agentInfo.description}</p>}
              <p className="text-[11px] text-zinc-600 font-mono mt-0.5">{config.agentId.slice(0, 20)}...</p>
            </div>
          </div>
          <div className="text-right shrink-0">
            <p className="text-[10px] text-zinc-500 font-semibold uppercase tracking-wider mb-0.5">Security</p>
            <p className="text-lg font-bold text-zinc-200 font-mono readout">DPAPI</p>
            <p className="text-[10px] text-zinc-700 font-mono mt-1">Secrets leave the config file.</p>
          </div>
        </div>
      </Section>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <div className="space-y-5">
          <Section title="LLM Engine">
            <div className="space-y-3.5">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Provider">
                  <select value={form.llmProvider} onChange={(event) => update("llmProvider", event.target.value)} className={inputClass}>
                    <option value="anthropic">Anthropic</option>
                    <option value="openai">OpenAI</option>
                    <option value="openrouter">OpenRouter</option>
                    <option value="ollama">Ollama</option>
                  </select>
                </Field>
                <Field label="Model">
                  <input type="text" value={form.llmModel} onChange={(event) => update("llmModel", event.target.value)} placeholder={isOllama ? "qwen3-coder-next" : "gpt-4o"} className={inputClass} />
                </Field>
              </div>
              {!isOllama ? (
                <Field label="API Key" hint="stored in protected local secret store">
                  <input type="password" value={form.llmApiKey} onChange={(event) => update("llmApiKey", event.target.value)} className={inputClass} />
                </Field>
              ) : (
                <Field label="Base URL" hint="loopback only">
                  <input type="text" value={form.llmBaseUrl} onChange={(event) => update("llmBaseUrl", event.target.value)} className={inputClass} />
                </Field>
              )}
              <div className="flex items-center gap-3">
                <button onClick={() => void testLlm()} disabled={llmTesting} className="px-3.5 py-2 rounded-md text-[12px] font-semibold transition-colors disabled:opacity-30 text-zinc-300 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700/50">
                  {llmTesting ? "Testing..." : "Test Connection"}
                </button>
                {llmTestResult && <span className="text-[11px] text-zinc-500 truncate flex-1 font-mono">{llmTestResult.slice(0, 100)}</span>}
              </div>
            </div>
          </Section>

          <Section title="Domain Fit">
            <div className="space-y-3.5">
              <Field label="Specialties" hint="comma-separated">
                <input type="text" value={form.specialties} onChange={(event) => update("specialties", event.target.value)} placeholder="inspection engineering, troubleshooting, preventive maintenance" className={inputClass} />
              </Field>
              <Field label="Decline Keywords" hint="auto-reject matching tasks">
                <input type="text" value={form.declineKeywords} onChange={(event) => update("declineKeywords", event.target.value)} placeholder="illegal, harmful, malware, self-harm" className={inputClass} />
              </Field>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Strategy">
                  <select value={form.strategy} onChange={(event) => update("strategy", event.target.value)} className={inputClass}>
                    <option value="fixed">Fixed</option>
                    <option value="complexity">Complexity</option>
                  </select>
                </Field>
                <Field label="Base Rate (USD)">
                  <input type="text" value={form.baseRate} onChange={(event) => update("baseRate", event.target.value)} className={inputClass} />
                  {ethPrice > 0 && <p className="text-[10px] text-zinc-600 mt-1 font-mono">~ {usdToEth(parseFloat(form.baseRate) || 0, ethPrice)} ETH</p>}
                </Field>
                <Field label="Max Rate (USD)">
                  <input type="text" value={form.maxRate} onChange={(event) => update("maxRate", event.target.value)} className={inputClass} />
                  {ethPrice > 0 && <p className="text-[10px] text-zinc-600 mt-1 font-mono">~ {usdToEth(parseFloat(form.maxRate) || 0, ethPrice)} ETH</p>}
                </Field>
              </div>
              <Field label="Max Concurrent Tasks">
                <input type="number" min={1} max={20} value={form.maxTasks} onChange={(event) => update("maxTasks", Number(event.target.value))} className={inputClass} />
              </Field>
            </div>
          </Section>

          <Section title="Automation">
            <div className="space-y-1">
              <Toggle label="Auto Quote" description="Allow the runtime to quote matching work automatically." checked={form.autoQuote} onChange={(value) => update("autoQuote", value)} />
              <Toggle label="Auto Work" description="Allow the runtime to begin accepted work automatically." checked={form.autoWork} onChange={(value) => update("autoWork", value)} />
              <Toggle label="Learning" description="Run study sessions while idle to improve future work." checked={form.learningEnabled} onChange={(value) => update("learningEnabled", value)} />
              <Toggle label="AgentCash" description="Enable paid external API usage when allowed by policy." checked={form.agentCashEnabled} onChange={(value) => update("agentCashEnabled", value)} />
            </div>
          </Section>

          <Section title="Approval Gates">
            <div className="space-y-1">
              <Toggle label="Quotes" description="Require operator approval before quoting clients." checked={form.approvalQuotes} onChange={(value) => update("approvalQuotes", value)} />
              <Toggle label="Declines" description="Require operator approval before declining tasks." checked={form.approvalDeclines} onChange={(value) => update("approvalDeclines", value)} />
              <Toggle label="Client Messages" description="Gate outbound client messages behind operator approval." checked={form.approvalClientMessages} onChange={(value) => update("approvalClientMessages", value)} />
              <Toggle label="Submissions" description="Require review before submitting final work." checked={form.approvalSubmissions} onChange={(value) => update("approvalSubmissions", value)} />
              <Toggle label="Bounty Claims" description="Gate bounty claim actions before funds or reputation move." checked={form.approvalBountyClaims} onChange={(value) => update("approvalBountyClaims", value)} />
              <Toggle label="AgentCash Calls" description="Require approval before paid external requests are executed." checked={form.approvalAgentCash} onChange={(value) => update("approvalAgentCash", value)} />
            </div>
          </Section>
        </div>

        <div className="space-y-5">
          <Section title="Logging And Retention">
            <div className="space-y-1">
              <Toggle label="Operator Chat" description="Persist operator chat transcripts in protected local storage." checked={form.persistOperatorChat} onChange={(value) => update("persistOperatorChat", value)} />
              <Toggle label="Knowledge" description="Persist retained knowledge entries locally." checked={form.persistKnowledge} onChange={(value) => update("persistKnowledge", value)} />
              <Toggle label="Feedback" description="Persist client feedback history locally." checked={form.persistFeedback} onChange={(value) => update("persistFeedback", value)} />
              <Toggle label="Datasets" description="Persist redacted task interaction exports for analysis." checked={form.persistDatasets} onChange={(value) => update("persistDatasets", value)} />
              <Toggle label="Activity Log" description="Persist the rolling runtime activity log locally." checked={form.persistActivityLog} onChange={(value) => update("persistActivityLog", value)} />
            </div>
            <div className="pt-3 border-t border-zinc-800/50">
              <Field label="Audit Retention (Days)">
                <input type="number" min={1} max={3650} value={form.auditRetentionDays} onChange={(event) => update("auditRetentionDays", Number(event.target.value))} className={inputClass} />
              </Field>
            </div>
          </Section>

          <Section title="AgentCash Controls">
            <div className="space-y-3.5">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Max USD Per Call">
                  <input type="number" min={0} step="0.01" value={form.agentCashMaxUsdPerCall} onChange={(event) => update("agentCashMaxUsdPerCall", Number(event.target.value))} className={inputClass} />
                </Field>
                <Field label="Max USD Per Task">
                  <input type="number" min={0} step="0.01" value={form.agentCashMaxUsdPerTask} onChange={(event) => update("agentCashMaxUsdPerTask", Number(event.target.value))} className={inputClass} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <ClassToggle label="Research APIs" description="Search, scrape, and research endpoints." checked={form.agentCashResearch} onChange={(value) => update("agentCashResearch", value)} />
                <ClassToggle label="Social APIs" description="Social network lookups and profile discovery." checked={form.agentCashSocial} onChange={(value) => update("agentCashSocial", value)} />
                <ClassToggle label="Media APIs" description="Image generation or media upload surfaces." checked={form.agentCashMedia} onChange={(value) => update("agentCashMedia", value)} />
                <ClassToggle label="Outbound APIs" description="Email or direct outbound communication endpoints." checked={form.agentCashOutbound} onChange={(value) => update("agentCashOutbound", value)} />
              </div>
              <p className="text-[11px] text-zinc-600">Disable classes you do not want the runtime to ever call, even after approval.</p>
            </div>
          </Section>

          <Section title="Operator Style">
            <div className="space-y-3.5">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Tone">
                  <select value={form.tone} onChange={(event) => update("tone", event.target.value as PersonalityData["tone"])} className={inputClass}>
                    <option value="professional">Professional</option>
                    <option value="casual">Casual</option>
                    <option value="friendly">Friendly</option>
                    <option value="technical">Technical</option>
                  </select>
                </Field>
                <Field label="Response Style">
                  <select value={form.responseStyle} onChange={(event) => update("responseStyle", event.target.value as PersonalityData["responseStyle"])} className={inputClass}>
                    <option value="concise">Concise</option>
                    <option value="detailed">Detailed</option>
                    <option value="balanced">Balanced</option>
                  </select>
                </Field>
              </div>
              <Field label="Custom Instructions" hint="optional">
                <textarea value={form.customInstructions} onChange={(event) => update("customInstructions", event.target.value)} rows={4} className={`${inputClass} resize-none`} />
              </Field>
            </div>
          </Section>

          <Section title="Timing">
            <div className="grid grid-cols-3 gap-3">
              <Field label="Study Interval">
                <div className="flex items-center gap-1.5">
                  <input type="number" min={1} max={1440} value={form.studyIntervalMin} onChange={(event) => update("studyIntervalMin", Number(event.target.value))} className={inputClass} />
                  <span className="text-[11px] text-zinc-600 shrink-0 font-mono">min</span>
                </div>
              </Field>
              <Field label="Fallback Sync">
                <div className="flex items-center gap-1.5">
                  <input type="number" min={5} max={600} value={form.pollIntervalSec} onChange={(event) => update("pollIntervalSec", Number(event.target.value))} className={inputClass} />
                  <span className="text-[11px] text-zinc-600 shrink-0 font-mono">sec</span>
                </div>
              </Field>
              <Field label="Urgent Sync">
                <div className="flex items-center gap-1.5">
                  <input type="number" min={3} max={120} value={form.urgentPollIntervalSec} onChange={(event) => update("urgentPollIntervalSec", Number(event.target.value))} className={inputClass} />
                  <span className="text-[11px] text-zinc-600 shrink-0 font-mono">sec</span>
                </div>
              </Field>
            </div>
          </Section>
        </div>
      </div>

      <div className="fixed bottom-0 left-[240px] right-0 z-20 border-t border-zinc-800/80 bg-[#09090b]/95 backdrop-blur-sm">
        <div className="px-10 py-3 flex items-center justify-end gap-4">
          {message && <span className={`text-[12px] font-semibold font-mono uppercase tracking-wider ${message === "SAVED" ? "text-emerald-400" : "text-red-400"}`}>{message}</span>}
          <button onClick={() => void save()} disabled={saving} className="px-5 py-2 rounded-md text-[13px] font-semibold transition-colors disabled:opacity-30 text-white bg-red-600 hover:bg-red-500">
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputClass = "w-full bg-zinc-900/80 border border-zinc-800/80 rounded-md px-3 py-2 text-[13px] text-zinc-300 focus:outline-none focus:border-zinc-600 transition-colors";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card p-5">
      <h3 className="text-sm font-bold text-zinc-200 uppercase tracking-wider mb-4">{title}</h3>
      {children}
    </div>
  );
}

function Toggle({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="w-full flex items-center justify-between py-2.5 px-1 group">
      <div className="text-left">
        <p className="text-[13px] font-medium text-zinc-300">{label}</p>
        <p className="text-[11px] text-zinc-600 mt-0.5">{description}</p>
      </div>
      <div className={`w-8 h-[18px] rounded-full transition-colors shrink-0 relative ${checked ? "bg-emerald-500" : "bg-zinc-700"}`}>
        <div className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-transform ${checked ? "left-[16px]" : "left-[2px]"}`} />
      </div>
    </button>
  );
}

function ClassToggle({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className={`rounded-md border px-3 py-3 text-left transition-colors ${checked ? "border-emerald-500/30 bg-emerald-500/10" : "border-zinc-800/80 bg-zinc-950/60 hover:border-zinc-700"}`}>
      <p className="text-[13px] font-medium text-zinc-300">{label}</p>
      <p className="text-[11px] text-zinc-600 mt-1">{description}</p>
    </button>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-1.5">
        <label className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{label}</label>
        {hint && <span className="text-[10px] text-zinc-700">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
