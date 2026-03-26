"use client";

import { useState, useRef, useEffect, useCallback } from "react";

interface Message {
  speaker: string;
  kind: "user" | "bot" | "error";
  text: string;
  thinking?: string;
}

interface HistorySession {
  id: string;
  title: string;
  chatUrl: string | null;
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [prompt, setPrompt] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [pdfLabel, setPdfLabel] = useState<string | null>(null);
  const [pdfIsNew, setPdfIsNew] = useState(false);
  const [statusText, setStatusText] = useState("Ready");
  const [historyMenuOpen, setHistoryMenuOpen] = useState(false);
  const [history, setHistory] = useState<HistorySession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const [waitingForResponse, setWaitingForResponse] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [partialText, setPartialText] = useState<string | null>(null);
  const [partialThinking, setPartialThinking] = useState<string | null>(null);

  const lastSeenSeqRef = useRef<number>(0);
  const chatBottomRef = useRef<HTMLDivElement>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const streamingRef = useRef(false);

  const scrollToBottom = () => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, partialText, partialThinking, streaming]);

  // Keep streamingRef in sync
  useEffect(() => {
    streamingRef.current = streaming;
  }, [streaming]);

  // Load history on mount
  useEffect(() => {
    fetchHistory();
  }, []);

  const fetchHistory = async () => {
    try {
      const res = await fetch("/chat_history");
      if (res.ok) {
        const data = await res.json();
        setHistory(data.sessions || []);
      }
    } catch {}
  };

  // Polling
  const doPoll = useCallback(async () => {
    try {
      const res = await fetch(`/poll_response?since=${lastSeenSeqRef.current}`);
      if (!res.ok) return;
      const data = await res.json();
      applyPoll(data);
    } catch {}
  }, []);

  useEffect(() => {
    if (waitingForResponse) {
      const intervalMs = streaming ? 500 : 1500;
      pollIntervalRef.current = setInterval(doPoll, intervalMs);
    } else {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    }
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, [waitingForResponse, streaming, doPoll]);

  const applyPoll = (data: any) => {
    const { status, partial_text, partial_thinking, responses } = data;

    if (status === "running") {
      if (partial_thinking && partial_thinking.trim()) {
        setPartialThinking(partial_thinking);
        setStatusText("Thinking…");
      }
      if (partial_text && partial_text.trim()) {
        setStreaming(true);
        setPartialText(partial_text);
        setStatusText("Streaming response…");
      } else if (partial_text === null && streamingRef.current) {
        setStreaming(false);
        setPartialText(null);
        setStatusText("Chrome request handling…");
      }
    }

    if (responses && responses.length > 0) {
      for (const resp of responses) {
        if (resp.seq <= lastSeenSeqRef.current) continue;
        lastSeenSeqRef.current = resp.seq;
        setWaitingForResponse(false);
        setStreaming(false);
        setPartialText(null);
        setPartialThinking(null);

        if (resp.error) {
          setMessages((prev) => [...prev, { speaker: "Error", text: resp.error, kind: "error" }]);
          setStatusText(`Error: ${resp.error}`);
        } else {
          setMessages((prev) => [
            ...prev,
            { speaker: "ChatGPT", text: resp.text, thinking: resp.thinking, kind: "bot" }
          ]);
          setStatusText("Response received — type a follow-up or pick a new PDF");
        }
        // Refresh history after response
        fetchHistory();
      }
    } else if (waitingForResponse && !streamingRef.current) {
      if (status === "pending") setStatusText("Waiting for extension to pick up query…");
      if (status === "running") setStatusText("Sending to ChatGPT…");
    }
  };

  const handleBrowse = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".pdf";
    input.onchange = (e: any) => {
      const file = e.target.files[0];
      if (file) {
        setSelectedFile(file);
        setPdfIsNew(true);
        setStatusText("PDF selected — next Send will start a new conversation");
      }
    };
    input.click();
  };

  const toBase64 = (file: File) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve((reader.result as string).split(",")[1]);
    reader.onerror = error => reject(error);
  });

  const handleSend = async () => {
    const p = prompt.trim();
    if (!p) return;

    const isNewConversation = pdfIsNew && selectedFile !== null;

    if (lastSeenSeqRef.current === 0 && !isNewConversation && !activeSessionId) {
      alert("Please select a PDF file before sending the first message.");
      return;
    }

    let pdfBase64 = null;
    let pdfFilename = null;

    if (isNewConversation && selectedFile) {
      try {
        pdfBase64 = await toBase64(selectedFile);
        pdfFilename = selectedFile.name;
      } catch (e: any) {
        alert("Cannot read PDF: " + e.message);
        return;
      }
      setPdfIsNew(false);
    }

    setMessages((prev) => [...prev, { speaker: "You", text: p, kind: "user" }]);
    setPrompt("");
    setStreaming(false);
    setPartialText(null);
    setPartialThinking(null);
    setWaitingForResponse(true);
    setStatusText("Sending…");

    try {
      const res = await fetch("/submit_query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: p,
          pdf_base64: pdfBase64,
          pdf_filename: pdfFilename,
        }),
      });
      const data = await res.json();
      if (data.error) {
        setMessages((prev) => [...prev, { speaker: "Error", text: data.error, kind: "error" }]);
        setStatusText(`Error: ${data.error}`);
        setWaitingForResponse(false);
      } else {
        if (data.sessionId) setActiveSessionId(data.sessionId);
        setStatusText("Waiting for extension to pick up query…");
        fetchHistory();
      }
    } catch (err: any) {
      setMessages((prev) => [...prev, { speaker: "Error", text: err.message, kind: "error" }]);
      setStatusText(`Error: ${err.message}`);
      setWaitingForResponse(false);
    }
  };

  const handleNewChat = async () => {
    try {
      await fetch("/new_chat", { method: "POST" });
      setMessages([]);
      setSelectedFile(null);
      setPdfLabel(null);
      setPdfIsNew(false);
      setActiveSessionId(null);
      lastSeenSeqRef.current = 0;
      setWaitingForResponse(false);
      setStreaming(false);
      setPartialText(null);
      setPartialThinking(null);
      setStatusText("New chat — select a PDF and type a prompt");
      fetchHistory();
    } catch (err: any) {
      setStatusText(`Error: ${err.message}`);
    }
  };

  const handleLoadChat = async (sessionId: string) => {
    try {
      const res = await fetch("/load_chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const data = await res.json();
      if (data.error) {
        setStatusText(`Error: ${data.error}`);
        return;
      }
      setActiveSessionId(data.session.id);
      setMessages(
        data.session.messages.map((m: any) => ({
          speaker: m.speaker,
          text: m.text,
          kind: m.kind,
          thinking: m.thinking,
        }))
      );
      if (data.session.pdfFilename) {
        setPdfLabel(data.session.pdfFilename);
        setSelectedFile(null);
        setPdfIsNew(false);
      } else {
        setPdfLabel(null);
      }
      lastSeenSeqRef.current = 0;
      setWaitingForResponse(false);
      setStreaming(false);
      setPartialText(null);
      setPartialThinking(null);
      setStatusText(data.session.chatUrl
        ? "Loaded past chat — type a follow-up"
        : "Loaded past chat (no ChatGPT URL — send a new PDF to continue)");
    } catch (err: any) {
      setStatusText(`Error: ${err.message}`);
    }
  };

  const handleDeleteChat = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation(); // prevent triggering handleLoadChat
    
    // Optimistic UI update
    setHistory(prev => prev.filter(s => s.id !== sessionId));
    if (activeSessionId === sessionId) {
      handleNewChat();
    }

    try {
      const res = await fetch("/delete_chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: sessionId }),
      });
      const data = await res.json();
      if (data.error) {
        setStatusText(`Error: ${data.error}`);
        // Re-fetch to restore state if delete failed
        fetchHistory();
      }
    } catch (err: any) {
      setStatusText(`Delete Error: ${err.message}`);
    }
  };

  return (
    <div className="llm-panel">
      {/* Header section */}
      <div className="llm-header">
        <div className="llm-header-top">
          <div className="llm-header-info">
            <div className="llm-title" style={{ display: "none" }}>LLM Assistant</div>
            <div className="llm-history-bar" style={{ display: "inline-flex" }}>
              <button
                className="llm-history-new"
                title="Start a new chat"
                aria-label="Start a new chat"
                onClick={handleNewChat}
              ></button>
              <button
                className="llm-history-toggle"
                title="Conversation history"
                aria-label="Conversation history"
                aria-haspopup="menu"
                aria-expanded={historyMenuOpen}
                onClick={() => setHistoryMenuOpen(!historyMenuOpen)}
              ></button>
              <div className="llm-mode-switch" data-mode="global">
                <button
                  className="llm-mode-chip"
                  title="Open chat"
                  aria-label="Open chat"
                >
                  Open chat
                </button>
                <button
                  className="llm-mode-lock"
                  title="Lock open chat as default"
                  aria-label="Lock open chat as default"
                  data-locked="false"
                  style={{ visibility: "visible" }}
                ></button>
              </div>
            </div>
          </div>
          <div className="llm-header-actions">
            <button
              className="llm-btn-icon llm-settings-btn"
              title="Settings"
              aria-label="Open plugin settings"
            ></button>
            <button className="llm-btn-icon" title="Export">⤓</button>
            <button className="llm-btn-icon" title="Clear">Clear</button>
          </div>
        </div>

        {/* Popup History Menu */}
        {historyMenuOpen && (
          <div className="llm-history-menu" style={{ display: "flex", top: "36px", left: "4px" }}>
            <div className="llm-history-menu-section-block">
              <div className="llm-history-menu-search">
                <input
                  type="text"
                  className="llm-history-menu-search-input"
                  placeholder="Search chat history..."
                />
              </div>
              <div className="llm-history-menu-section-viewport" data-scroll-limited="true">
                <div className="llm-history-menu-section-rows">
                  {history.length === 0 && (
                    <div style={{ padding: "8px", fontSize: "11px", color: "var(--fill-tertiary)" }}>
                      No chats yet
                    </div>
                  )}
                  {history.map((s) => (
                    <div
                      key={s.id}
                      className={`llm-history-menu-row ${s.id === activeSessionId ? "active" : ""}`}
                    >
                      <button
                        className="llm-history-menu-row-main"
                        onClick={() => {
                          handleLoadChat(s.id);
                          setHistoryMenuOpen(false);
                        }}
                      >
                        <div className="llm-history-menu-row-title" title={s.title}>
                          {s.title}
                        </div>
                        <div className="llm-history-menu-row-subtitle">
                          ChatGPT Web Sync
                        </div>
                      </button>
                      <button
                        className="llm-history-menu-row-action"
                        title="Delete Chat"
                        onClick={(e) => handleDeleteChat(e, s.id)}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 6h18"></path>
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Chat shell area */}
      <div className="llm-chat-shell">
        <div className="llm-messages">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`llm-message ${
                msg.kind === "user" ? "llm-message-user" : "llm-message-assistant"
              } ${msg.kind === "error" ? "llm-message-error" : ""}`}
            >
              <div className="llm-message-header">
                <div className="llm-message-author">{msg.speaker}</div>
              </div>
              
              {/* Adapt our custom thinking block to the new UI */}
              {msg.thinking && (
                <details className="llm-message-process" style={{ marginBottom: "8px" }}>
                  <summary className="llm-message-process-summary">
                    <span className="llm-message-process-icon">💭</span>
                    <span className="llm-message-process-title">Thought process</span>
                  </summary>
                  <div className="llm-message-process-content" style={{ marginTop: "4px", fontSize: "11px", opacity: 0.9 }}>
                    {msg.thinking}
                  </div>
                </details>
              )}

              <div className="llm-message-content">
                <p>{msg.text}</p>
              </div>
            </div>
          ))}

          {streaming && (partialThinking || partialText) && (
            <div className="llm-message llm-message-assistant llm-message-streaming">
              <div className="llm-message-header">
                <div className="llm-message-author">ChatGPT</div>
              </div>

              {partialThinking && (
                <div className="llm-message-process" style={{ marginBottom: "8px" }}>
                  <div className="llm-message-process-summary">
                    <span className="llm-message-process-icon" style={{ animation: "pulse 1.5s infinite" }}>💭</span>
                    <span className="llm-message-process-title">Thinking…</span>
                  </div>
                  <div className="llm-message-process-content" style={{ marginTop: "4px", fontSize: "11px", opacity: 0.9 }}>
                    {partialThinking}
                  </div>
                </div>
              )}

              {partialText && (
                <div className="llm-message-content" style={{ opacity: 0.8 }}>
                  <p>{partialText} ▌</p>
                </div>
              )}
            </div>
          )}
          <div ref={chatBottomRef} />
        </div>
      </div>

      {/* Input section */}
      <div className="llm-input-section">
        {/* PDF Context Preview Row */}
        <div className="llm-context-previews">
          <button
            title="Upload PDF"
            aria-label="Upload PDF"
            onClick={handleBrowse}
            style={{ 
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'center', 
              padding: '4px 8px', 
              marginRight: '8px', 
              borderRadius: '6px',
              background: 'rgba(255,255,255,0.05)', 
              border: '1px solid var(--stroke-secondary)', 
              cursor: 'pointer', 
              color: 'var(--fill-primary)' 
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{marginRight: '6px'}}>
              <line x1="22" y1="2" x2="11" y2="13"></line>
              <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
            </svg>
            <span style={{fontSize: '11px'}}>Upload</span>
          </button>

          <button
            className="llm-context-agent-toggle llm-agent-process-summary"
            title="Switch to Agent mode"
            aria-label="Switch to Agent mode"
            aria-pressed="false"
          >
            <span className="llm-agent-toggle-indicator" aria-hidden="true"></span>
            <span className="llm-agent-toggle-label llm-agent-process-summary-label">Agent mode</span>
          </button>

          {/* If a file is selected, show it like llm-for-zotero does */}
          {selectedFile || pdfLabel ? (
            <div className="llm-image-preview" style={{ display: "flex" }}>
              <div className="llm-image-preview-header">
                <button className="llm-image-preview-meta llm-file-context-meta">
                  1 file
                </button>
                <button className="llm-remove-img-btn" title="Clear uploaded files" onClick={() => { setSelectedFile(null); setPdfLabel(null); }}>
                  ×
                </button>
              </div>
              <div className="llm-image-preview-expanded llm-file-context-expanded" style={{ display: "none" }}>
                <div className="llm-file-context-list">
                  <div className="llm-file-context-item">
                    <span className="llm-file-context-item-icon">📄</span>
                    <span className="llm-file-context-item-name">{selectedFile ? selectedFile.name : pdfLabel}</span>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <div className="llm-compose-area">
          <textarea
            className="llm-input"
            placeholder="Ask anything... Type / for actions"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                handleSend();
              }
            }}
          />
        </div>

        <div className="llm-actions">
          <div className="llm-actions-left">
            <div className="llm-action-slot">
              <button
                className="llm-shortcut-btn llm-action-btn llm-action-btn-secondary llm-upload-file-btn llm-slash-menu-btn"
                title="Upload file"
                onClick={handleBrowse}
              >
                Upload {selectedFile || pdfLabel ? "(1)" : ""}
              </button>
            </div>
          </div>
          
          <div className="llm-actions-right">
            <div className="llm-status-bar">
              <div className="llm-status">
                {statusText}
                {(statusText.includes("Thinking") || statusText.includes("Waiting") || statusText.includes("Sending")) && (
                  <span className="dot-flashing" style={{display: "inline-block", marginLeft: "4px"}}>...</span>
                )}
              </div>
            </div>
            <div className="llm-action-slot">
              <button
                className="llm-shortcut-btn llm-action-btn llm-action-btn-primary llm-send-btn"
                onClick={handleSend}
                disabled={waitingForResponse && !streaming}
              >
                Send
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
