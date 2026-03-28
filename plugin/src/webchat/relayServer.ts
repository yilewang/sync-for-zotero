/**
 * [webchat] Embedded HTTP relay server for the ChatGPT web sync pipeline.
 *
 * Registers endpoints on Zotero's built-in HTTP server (port 23119)
 * so no external relay process is needed.
 *
 * The Chrome extension polls these endpoints to pick up queries,
 * post streaming partials, and submit final responses.
 *
 * Endpoints:
 *   POST /llm-for-zotero/webchat/submit_query
 *   GET  /llm-for-zotero/webchat/poll_query
 *   GET  /llm-for-zotero/webchat/poll_response
 *   POST /llm-for-zotero/webchat/update_partial
 *   POST /llm-for-zotero/webchat/submit_response
 *   GET  /llm-for-zotero/webchat/poll_command
 *   POST /llm-for-zotero/webchat/new_chat
 *   GET  /llm-for-zotero/webchat/chat_history
 *   POST /llm-for-zotero/webchat/chat_history
 *   POST /llm-for-zotero/webchat/update_chat_history
 *   POST /llm-for-zotero/webchat/update_chat_url
 *   POST /llm-for-zotero/webchat/load_chat
 */

const PREFIX = "/llm-for-zotero/webchat";
const PRE_SUBMIT_RECLAIM_MS = 120_000;
const PIPELINE_TIMEOUT_MS = 180_000;

/**
 * Get the actual base URL of the embedded relay server.
 * Zotero's HTTP server port can vary (23119, 23120, etc.) so we read it dynamically.
 */
export function getRelayBaseUrl(): string {
  const port = Zotero.Prefs.get("httpServer.port") || 23119;
  return `http://localhost:${port}${PREFIX}`;
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

interface PendingCommand {
  type: "NEW_CHAT" | "LOAD_CHAT" | "DELETE_CHAT";
  chatUrl?: string;
  chatId?: string;
}

export type RelayQueryPhase =
  | "pending"
  | "claimed"
  | "prompt_applied"
  | "submitted"
  | "streaming"
  | "done"
  | "error";

export interface RelayState {
  status: "idle" | "pending" | "running" | "done" | "error";
  query: {
    prompt: string | null;
    pdf_base64: string | null;
    pdf_filename: string | null;
    images: string[] | null;
    chatgpt_mode: string | null;
    force_new_chat: boolean;
    seq: number;
    attempt: number;
    phase: RelayQueryPhase;
  };
  active_seq: number;
  active_attempt: number;
  running_since: number;
  partial_text: string | null;
  partial_thinking: string | null;
  responses: Array<{
    seq: number;
    attempt?: number;
    text?: string;
    error?: string;
    timestamp: string;
    thinking?: string;
  }>;
  activeSessionId: string | null;
  pendingCommand: PendingCommand | null;
  /** [webchat] Actual ChatGPT mode reported back by the extension. */
  reported_mode: string | null;
}

// Use Zotero object as shared namespace — guaranteed same across all contexts
// in the plugin (globalThis may differ between sandbox scopes in Gecko)
const Z = Zotero as unknown as {
  _webchatRelay?: {
    state: RelayState;
    mirroredHistory: Array<{ id: string; title: string; chatUrl: string }>;
    scrapedMessages: Array<{ role: string; text: string }> | null;
  };
};

if (!Z._webchatRelay) {
  Z._webchatRelay = {
    state: {
      status: "idle",
      query: {
        prompt: null,
        pdf_base64: null,
        pdf_filename: null,
        images: null,
        chatgpt_mode: null,
        force_new_chat: false,
        seq: 0,
        attempt: 0,
        phase: "pending",
      },
      active_seq: 0,
      active_attempt: 0,
      running_since: 0,
      partial_text: null,
      partial_thinking: null,
      responses: [],
      activeSessionId: null,
      pendingCommand: null,
      reported_mode: null,
    },
    mirroredHistory: [],
    scrapedMessages: null,
  };
}

// Access shared state via Zotero.Server.Endpoints — this object is guaranteed
// to be the same in both the plugin's scope and the server's handler scope,
// because we register endpoint classes directly on it.
const STORAGE_KEY = "__webchatRelayStorage";

function _store(): { state: RelayState; mirroredHistory: Array<{ id: string; title: string; chatUrl: string }>; scrapedMessages: Array<{ role: string; text: string }> | null } {
  const ep = Zotero.Server.Endpoints as any;
  if (!ep[STORAGE_KEY]) {
    ep[STORAGE_KEY] = Z._webchatRelay;
  }
  return ep[STORAGE_KEY];
}

function S(): RelayState { return _store().state; }
function getMirroredHistory(): Array<{ id: string; title: string; chatUrl: string }> { return _store().mirroredHistory; }
function setMirroredHistory(h: Array<{ id: string; title: string; chatUrl: string }>) { _store().mirroredHistory = h; }
function getScrapedMessages(): Array<{ role: string; text: string }> | null { return _store().scrapedMessages; }
function setScrapedMessages(m: Array<{ role: string; text: string }> | null) { _store().scrapedMessages = m; }

function resetState() {
  const prevSeq = S().query.seq; // preserve seq counter so background.js doesn't skip new queries
  S().status = "idle";
  S().query = {
    prompt: null,
    pdf_base64: null,
    pdf_filename: null,
    images: null,
    chatgpt_mode: null,
    force_new_chat: false,
    seq: prevSeq,
    attempt: 0,
    phase: "pending",
  };
  S().active_seq = 0;
  S().active_attempt = 0;
  S().running_since = 0;
  S().partial_text = null;
  S().partial_thinking = null;
  S().responses = [];
  S().activeSessionId = null;
  S().pendingCommand = null;
  S().reported_mode = null;
}

// ---------------------------------------------------------------------------
// Helper types
// ---------------------------------------------------------------------------

type EndpointOptions = {
  method: "GET" | "POST";
  pathname: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  data: unknown;
};

type EndpointResponse =
  | number
  | [number, string | Record<string, string>, string?];

function jsonReply(
  data: Record<string, unknown>,
  status = 200,
): EndpointResponse {
  return [status, "application/json", JSON.stringify(data)];
}

function parseBody(data: unknown): Record<string, unknown> {
  if (typeof data === "string") return JSON.parse(data);
  if (typeof data === "object" && data !== null) return data as Record<string, unknown>;
  return {};
}

function isPreSubmitPhase(phase: RelayQueryPhase): boolean {
  return phase === "claimed" || phase === "prompt_applied";
}

function copyQueryState(): RelayState["query"] {
  return { ...S().query };
}

function phaseOrder(phase: RelayQueryPhase): number {
  switch (phase) {
    case "pending":
      return 0;
    case "claimed":
      return 1;
    case "prompt_applied":
      return 2;
    case "submitted":
      return 3;
    case "streaming":
      return 4;
    case "done":
      return 5;
    case "error":
      return 6;
    default:
      return 0;
  }
}

function expireStaleClaimIfNeeded(): void {
  if (
    S().status !== "running" ||
    S().active_seq <= 0 ||
    !isPreSubmitPhase(S().query.phase) ||
    S().running_since <= 0
  ) {
    return;
  }

  if (Date.now() - S().running_since <= PRE_SUBMIT_RECLAIM_MS) {
    return;
  }

  S().status = "pending";
  S().query.phase = "pending";
  S().active_seq = 0;
  S().active_attempt = 0;
  S().running_since = 0;
  S().partial_text = null;
  S().partial_thinking = null;
}

function attemptMatches(body: Record<string, unknown>): boolean {
  if (!("attempt" in body) || body.attempt == null) return true;
  return Number(body.attempt) === S().active_attempt;
}

function isRunningExpired(): boolean {
  if (S().status !== "running" || S().running_since <= 0) return false;
  const elapsed = Date.now() - S().running_since;
  if (isPreSubmitPhase(S().query.phase)) {
    return elapsed > PRE_SUBMIT_RECLAIM_MS;
  }
  return elapsed > PIPELINE_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Endpoint definitions
// ---------------------------------------------------------------------------

function createEndpoint(
  methods: string[],
  handler: (opts: EndpointOptions) => Promise<EndpointResponse> | EndpointResponse,
) {
  return class {
    supportedMethods = methods;
    supportedDataTypes = ["application/json"];
    init = async (opts: EndpointOptions): Promise<EndpointResponse> => {
      try {
        return await handler(opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return jsonReply({ error: msg }, 500);
      }
    };
  };
}

// POST /submit_query
const SubmitQueryEndpoint = createEndpoint(["POST"], (opts) => {
  const body = parseBody(opts.data);
  expireStaleClaimIfNeeded();

  if (S().status === "pending" || S().status === "running") {
    if (S().status === "running" && isRunningExpired()) {
      S().status = "error";
      S().query.phase = "error";
    } else {
      return jsonReply({ error: "pipeline_busy", status: S().status });
    }
  }

  // Clear stale state
  S().responses = [];
  S().active_seq = 0;
  S().partial_text = null;
  S().partial_thinking = null;

  S().query.seq += 1;
  S().query.prompt = (body.prompt as string) || "";
  S().query.pdf_base64 = (body.pdf_base64 as string) || null;
  S().query.pdf_filename = (body.pdf_filename as string) || null;
  S().query.images = (body.images as string[]) || null;
  S().query.chatgpt_mode = (body.chatgpt_mode as string) || null;
  S().query.force_new_chat = body.force_new_chat === true;
  S().query.attempt = 0;
  S().query.phase = "pending";
  S().status = "pending";

  // If this query requests a new chat, clear any pending NEW_CHAT command
  // to prevent the extension from double-navigating (the query's force_new_chat
  // flag will handle navigation in runPipeline).
  if (body.force_new_chat && S().pendingCommand?.type === "NEW_CHAT") {
    S().pendingCommand = null;
  }

  return jsonReply({ ok: true, seq: S().query.seq });
});

// GET /poll_query
const PollQueryEndpoint = createEndpoint(["GET"], () => {
  expireStaleClaimIfNeeded();
  if (S().status === "pending") {
    return jsonReply({ status: "pending", query: copyQueryState() });
  }
  return jsonReply({ status: S().status, query: null });
});

// POST /claim_query
const ClaimQueryEndpoint = createEndpoint(["POST"], (opts) => {
  const body = parseBody(opts.data);
  const seq = Number(body.seq || 0);
  expireStaleClaimIfNeeded();

  if (S().status !== "pending" || seq !== S().query.seq) {
    return jsonReply({ ok: false, reason: "not_pending", status: S().status });
  }

  S().status = "running";
  S().active_seq = S().query.seq;
  S().query.attempt += 1;
  S().active_attempt = S().query.attempt;
  S().query.phase = "claimed";
  S().running_since = Date.now();
  S().partial_text = null;
  S().partial_thinking = null;

  return jsonReply({
    ok: true,
    query: copyQueryState(),
  });
});

// POST /ack_query_phase
const AckQueryPhaseEndpoint = createEndpoint(["POST"], (opts) => {
  const body = parseBody(opts.data);
  const nextPhase = (body.phase as RelayQueryPhase | undefined) || "claimed";
  expireStaleClaimIfNeeded();

  if (body.seq !== S().active_seq) {
    return jsonReply({ ok: false, reason: "seq_mismatch" });
  }
  if (!attemptMatches(body)) {
    return jsonReply({ ok: false, reason: "attempt_mismatch" });
  }
  if (phaseOrder(nextPhase) < phaseOrder(S().query.phase)) {
    return jsonReply({ ok: false, reason: "phase_regression" });
  }

  S().query.phase = nextPhase;
  if (nextPhase === "claimed" || nextPhase === "prompt_applied") {
    S().running_since = Date.now();
  }
  if (nextPhase === "submitted" || nextPhase === "streaming") {
    S().running_since = Date.now();
  }

  return jsonReply({ ok: true });
});

// POST /release_query
const ReleaseQueryEndpoint = createEndpoint(["POST"], (opts) => {
  const body = parseBody(opts.data);

  if (body.seq !== S().active_seq) {
    return jsonReply({ ok: false, reason: "seq_mismatch" });
  }
  if (!attemptMatches(body)) {
    return jsonReply({ ok: false, reason: "attempt_mismatch" });
  }
  if (!isPreSubmitPhase(S().query.phase)) {
    return jsonReply({ ok: false, reason: "already_submitted" });
  }

  S().status = "pending";
  S().query.phase = "pending";
  S().active_seq = 0;
  S().active_attempt = 0;
  S().running_since = 0;
  S().partial_text = null;
  S().partial_thinking = null;

  return jsonReply({ ok: true, query: copyQueryState() });
});

// GET /poll_response
const PollResponseEndpoint = createEndpoint(["GET"], () => {
  expireStaleClaimIfNeeded();
  // Passive timeout
  if (
    S().status === "running" &&
    S().running_since > 0 &&
    Date.now() - S().running_since > PIPELINE_TIMEOUT_MS
  ) {
    S().status = "error";
    S().query.phase = "error";
    S().responses.push({
      seq: S().active_seq,
      attempt: S().active_attempt || undefined,
      error: "Server-side timeout: pipeline running for > 180s",
      timestamp: new Date().toISOString(),
    });
  }

  return jsonReply({
    status: S().status,
    responses: S().responses,
    partial_text: S().partial_text,
    partial_thinking: S().partial_thinking,
    current_seq: S().query.seq,
  });
});

// POST /update_partial
const UpdatePartialEndpoint = createEndpoint(["POST"], (opts) => {
  const body = parseBody(opts.data);
  expireStaleClaimIfNeeded();
  if (body.seq !== S().active_seq) {
    return jsonReply({ ok: false, reason: "seq_mismatch" });
  }
  if (!attemptMatches(body)) {
    return jsonReply({ ok: false, reason: "attempt_mismatch" });
  }
  if ("text" in body) S().partial_text = body.text as string | null;
  if ("thinking" in body) S().partial_thinking = body.thinking as string | null;
  if (
    (typeof body.text === "string" && body.text.length > 0) ||
    (typeof body.thinking === "string" && body.thinking.length > 0)
  ) {
    S().query.phase = "streaming";
  }
  return jsonReply({ ok: true });
});

// POST /submit_response
const SubmitResponseEndpoint = createEndpoint(["POST"], (opts) => {
  const body = parseBody(opts.data);
  expireStaleClaimIfNeeded();
  if (body.seq !== S().active_seq) {
    return jsonReply({ ok: false, reason: "seq_mismatch" });
  }
  if (!attemptMatches(body)) {
    return jsonReply({ ok: false, reason: "attempt_mismatch" });
  }

  const entry = {
    seq: body.seq as number,
    attempt: ("attempt" in body ? Number(body.attempt) : S().active_attempt) || undefined,
    text: body.response as string | undefined,
    error: body.error as string | undefined,
    timestamp: new Date().toISOString(),
    thinking: body.thinking as string | undefined,
  };
  S().responses.push(entry);
  S().partial_text = null;
  S().partial_thinking = null;
  S().status = entry.error ? "error" : "done";
  S().query.phase = entry.error ? "error" : "done";

  return jsonReply({ ok: true });
});

// GET /debug (temporary — shows which state object the endpoint sees)
const DebugEndpoint = createEndpoint(["GET"], () => {
  const s = S();
  return jsonReply({
    stateRef: typeof s,
    status: s?.status,
    phase: s?.query?.phase,
    attempt: s?.query?.attempt,
    pendingCommand: s?.pendingCommand,
    storageKeyExists: !!(Zotero.Server.Endpoints as any).__webchatRelayStorage,
    sameRef: s === (Zotero.Server.Endpoints as any).__webchatRelayStorage?.state,
  });
});

// GET /poll_command
const PollCommandEndpoint = createEndpoint(["GET"], () => {
  const cmd = S().pendingCommand;
  if (cmd) {
    S().pendingCommand = null;
    return jsonReply({ command: cmd });
  }
  return jsonReply({ command: null });
});

// POST /new_chat
const NewChatEndpoint = createEndpoint(["POST"], () => {
  resetState();
  S().pendingCommand = { type: "NEW_CHAT" };
  return jsonReply({ ok: true });
});

// GET + POST /chat_history
const ChatHistoryEndpoint = createEndpoint(["GET", "POST"], (opts) => {
  if (opts.method === "POST") {
    const body = parseBody(opts.data);
    if (body.action === "submit_scraped") {
      setScrapedMessages((body.messages as Array<{ role: string; text: string }>) || []);
      return jsonReply({ ok: true });
    }
    return jsonReply({ error: "Unknown action" }, 400);
  }

  // GET
  if (opts.query?.action === "get_scraped") {
    const messages = getScrapedMessages();
    setScrapedMessages(null);
    return jsonReply({ messages: messages as unknown as Record<string, unknown> });
  }

  return jsonReply({
    sessions: getMirroredHistory().map((s) => ({
      id: s.id,
      title: s.title,
      chatUrl: s.chatUrl,
    })),
  });
});

// POST /update_chat_history
const UpdateChatHistoryEndpoint = createEndpoint(["POST"], (opts) => {
  const body = parseBody(opts.data);
  if (Array.isArray(body.sessions)) {
    setMirroredHistory(body.sessions as Array<{ id: string; title: string; chatUrl: string }>);
  }
  return jsonReply({ success: true });
});

// POST /update_chat_url
const UpdateChatUrlEndpoint = createEndpoint(["POST"], () => {
  // Chat URL tracking (minimal — just acknowledge)
  return jsonReply({ ok: true });
});

// POST /update_mode — extension reports ChatGPT's actual thinking mode
const UpdateModeEndpoint = createEndpoint(["POST"], (opts) => {
  const body = parseBody(opts.data);
  const mode = body.mode as string | undefined;
  if (mode) S().reported_mode = mode;
  return jsonReply({ ok: true });
});

// POST /load_chat
const LoadChatEndpoint = createEndpoint(["POST"], (opts) => {
  const body = parseBody(opts.data);
  const sessionId = body.sessionId as string;

  // Look up in mirrored history
  const session = getMirroredHistory().find((s) => s.id === sessionId);

  resetState();

  if (session?.chatUrl) {
    S().pendingCommand = { type: "LOAD_CHAT", chatUrl: session.chatUrl };
  }

  return jsonReply({
    ok: true,
    session: session
      ? { id: session.id, title: session.title, chatUrl: session.chatUrl, messages: [] }
      : { id: sessionId, title: "Unknown", chatUrl: null, messages: [] },
  });
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const ENDPOINTS: Record<string, ReturnType<typeof createEndpoint>> = {
  [`${PREFIX}/debug`]: DebugEndpoint,
  [`${PREFIX}/submit_query`]: SubmitQueryEndpoint,
  [`${PREFIX}/poll_query`]: PollQueryEndpoint,
  [`${PREFIX}/claim_query`]: ClaimQueryEndpoint,
  [`${PREFIX}/ack_query_phase`]: AckQueryPhaseEndpoint,
  [`${PREFIX}/release_query`]: ReleaseQueryEndpoint,
  [`${PREFIX}/poll_response`]: PollResponseEndpoint,
  [`${PREFIX}/update_partial`]: UpdatePartialEndpoint,
  [`${PREFIX}/submit_response`]: SubmitResponseEndpoint,
  [`${PREFIX}/poll_command`]: PollCommandEndpoint,
  [`${PREFIX}/new_chat`]: NewChatEndpoint,
  [`${PREFIX}/chat_history`]: ChatHistoryEndpoint,
  [`${PREFIX}/update_chat_history`]: UpdateChatHistoryEndpoint,
  [`${PREFIX}/update_chat_url`]: UpdateChatUrlEndpoint,
  [`${PREFIX}/update_mode`]: UpdateModeEndpoint,
  [`${PREFIX}/load_chat`]: LoadChatEndpoint,
};

// ---------------------------------------------------------------------------
// Direct-access API (for plugin use — bypasses HTTP to avoid deadlock)
// ---------------------------------------------------------------------------

/** Submit a query directly to the relay state (no HTTP). */
export function relaySubmitQuery(opts: {
  prompt: string;
  pdf_base64?: string | null;
  pdf_filename?: string | null;
  images?: string[] | null;
  chatgpt_mode?: string | null;
  force_new_chat?: boolean;
}): { ok: boolean; seq: number; error?: string } {
  expireStaleClaimIfNeeded();
  if (S().status === "pending" || S().status === "running") {
    if (S().status === "running" && isRunningExpired()) {
      S().status = "error";
      S().query.phase = "error";
    } else {
      return { ok: false, seq: 0, error: "pipeline_busy" };
    }
  }

  S().responses = [];
  S().active_seq = 0;
  S().partial_text = null;
  S().partial_thinking = null;
  S().query.seq += 1;
  S().query.prompt = opts.prompt || "";
  S().query.pdf_base64 = opts.pdf_base64 || null;
  S().query.pdf_filename = opts.pdf_filename || null;
  S().query.images = opts.images || null;
  S().query.chatgpt_mode = opts.chatgpt_mode || null;
  S().query.force_new_chat = opts.force_new_chat === true;
  S().query.attempt = 0;
  S().query.phase = "pending";
  S().status = "pending";

  // If this query requests a new chat, clear any pending NEW_CHAT command
  // to prevent the extension from double-navigating (the query's force_new_chat
  // flag will handle navigation in runPipeline).
  if (opts.force_new_chat && S().pendingCommand?.type === "NEW_CHAT") {
    S().pendingCommand = null;
  }

  return { ok: true, seq: S().query.seq };
}

/** Peek at the pending query without consuming it. */
export function relayPollQuery(): {
  status: RelayState["status"];
  query: RelayState["query"] | null;
} {
  expireStaleClaimIfNeeded();
  if (S().status === "pending") {
    return { status: "pending", query: copyQueryState() };
  }
  return { status: S().status, query: null };
}

/** Claim the current pending query for an extension attempt. */
export function relayClaimQuery(seq: number): {
  ok: boolean;
  reason?: string;
  query?: RelayState["query"];
} {
  expireStaleClaimIfNeeded();
  if (S().status !== "pending" || seq !== S().query.seq) {
    return { ok: false, reason: "not_pending" };
  }

  S().status = "running";
  S().active_seq = S().query.seq;
  S().query.attempt += 1;
  S().active_attempt = S().query.attempt;
  S().query.phase = "claimed";
  S().running_since = Date.now();
  S().partial_text = null;
  S().partial_thinking = null;

  return {
    ok: true,
    query: copyQueryState(),
  };
}

/** Advance the claimed query to the reported delivery phase. */
export function relayAckQueryPhase(
  seq: number,
  phase: RelayQueryPhase,
  attempt?: number,
): { ok: boolean; reason?: string } {
  expireStaleClaimIfNeeded();
  if (seq !== S().active_seq) {
    return { ok: false, reason: "seq_mismatch" };
  }
  if (typeof attempt === "number" && attempt !== S().active_attempt) {
    return { ok: false, reason: "attempt_mismatch" };
  }
  if (phaseOrder(phase) < phaseOrder(S().query.phase)) {
    return { ok: false, reason: "phase_regression" };
  }

  S().query.phase = phase;
  if (phase === "claimed" || phase === "prompt_applied" || phase === "submitted" || phase === "streaming") {
    S().running_since = Date.now();
  }
  return { ok: true };
}

/** Release a claimed query back to pending before ChatGPT accepts it. */
export function relayReleaseQuery(
  seq: number,
  attempt?: number,
): { ok: boolean; reason?: string } {
  if (seq !== S().active_seq) {
    return { ok: false, reason: "seq_mismatch" };
  }
  if (typeof attempt === "number" && attempt !== S().active_attempt) {
    return { ok: false, reason: "attempt_mismatch" };
  }
  if (!isPreSubmitPhase(S().query.phase)) {
    return { ok: false, reason: "already_submitted" };
  }

  S().status = "pending";
  S().query.phase = "pending";
  S().active_seq = 0;
  S().active_attempt = 0;
  S().running_since = 0;
  S().partial_text = null;
  S().partial_thinking = null;

  return { ok: true };
}

/** Poll for response directly from relay state (no HTTP). */
export function relayPollResponse(): {
  status: string;
  responses: RelayState["responses"];
  partial_text: string | null;
  partial_thinking: string | null;
  current_seq: number;
} {
  expireStaleClaimIfNeeded();
  // Passive timeout
  if (S().status === "running" && S().running_since > 0 && Date.now() - S().running_since > PIPELINE_TIMEOUT_MS) {
    S().status = "error";
    S().query.phase = "error";
    S().responses.push({
      seq: S().active_seq,
      attempt: S().active_attempt || undefined,
      error: "Server-side timeout: pipeline running for > 180s",
      timestamp: new Date().toISOString(),
    });
  }

  return {
    status: S().status,
    responses: S().responses,
    partial_text: S().partial_text,
    partial_thinking: S().partial_thinking,
    current_seq: S().query.seq,
  };
}

/** Send new chat command directly (no HTTP). */
export function relayNewChat(): void {
  resetState();
  S().pendingCommand = { type: "NEW_CHAT" };
}

/** Set a pending command directly (no HTTP). */
export function relaySetCommand(cmd: { type: string; chatUrl?: string; chatId?: string }): void {
  S().pendingCommand = cmd as any;
}

/** Load a chat session directly (no HTTP). */
export function relayLoadChat(sessionId: string): {
  ok: boolean;
  session: { id: string; title: string; chatUrl: string | null; messages: unknown[] };
} {
  const session = getMirroredHistory().find((s) => s.id === sessionId);
  resetState();
  if (session?.chatUrl) {
    S().pendingCommand = { type: "LOAD_CHAT", chatUrl: session.chatUrl };
  }
  return {
    ok: true,
    session: session
      ? { id: session.id, title: session.title, chatUrl: session.chatUrl, messages: [] }
      : { id: sessionId, title: "Unknown", chatUrl: null, messages: [] },
  };
}

/** Get mirrored chat history directly (no HTTP). */
export function relayGetChatHistory(): Array<{ id: string; title: string; chatUrl: string | null }> {
  return getMirroredHistory().map((s) => ({ id: s.id, title: s.title, chatUrl: s.chatUrl }));
}

/** Get the reported ChatGPT mode (set by extension via /update_mode). */
export function relayGetReportedMode(): string | null {
  return S().reported_mode;
}

/** Get and clear scraped messages directly (no HTTP). */
export function relayGetScrapedMessages(): Array<{ role: string; text: string }> | null {
  const msgs = getScrapedMessages();
  setScrapedMessages(null);
  return msgs;
}

/** Test-only visibility into the relay state. */
export function relayGetStateSnapshot(): RelayState {
  expireStaleClaimIfNeeded();
  return JSON.parse(JSON.stringify(S())) as RelayState;
}

/** Test helper to reset relay state without issuing commands. */
export function relayResetForTests(): void {
  resetState();
}

/**
 * Register all webchat relay endpoints on Zotero's built-in HTTP server.
 * Call during plugin startup.
 */
export function registerWebChatRelay(): void {
  for (const [path, EndpointClass] of Object.entries(ENDPOINTS)) {
    Zotero.Server.Endpoints[path] = EndpointClass;
  }
  const port = Zotero.Prefs.get("httpServer.port") || 23119;
  ztoolkit.log(
    `[webchat] Relay registered: ${Object.keys(ENDPOINTS).length} endpoints on port ${port}`,
  );
}

/**
 * Remove all webchat relay endpoints from Zotero's server.
 * Call during plugin shutdown.
 */
export function unregisterWebChatRelay(): void {
  for (const path of Object.keys(ENDPOINTS)) {
    delete Zotero.Server.Endpoints[path];
  }
}
