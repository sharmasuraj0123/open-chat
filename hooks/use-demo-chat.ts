"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEMO_STORAGE_PREFIX, MAX_DEMO_MESSAGES, MAX_MESSAGE_LENGTH, parseDemoReplies, restoreDemoSession, sampleReply, type DemoMessage } from "@/lib/demo-chat";
import { chatLogPath, parseChatLog, type ChatTurn } from "@/lib/chat-log";
import { useWorkspace } from "./use-workspace";

/** On the hub, turns are saved to `<conversation>.log.jsonl`; `blocked` explains why saving cannot work yet. */
export type HubChat = { savedTo: string; blocked?: string };

const shortTime = (iso?: string) => {
  const date = iso ? new Date(iso) : undefined;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : undefined;
};

export function useDemoChat(conversationPath: string | undefined, repliesPath: string | undefined, rootId = "default", hub?: HubChat) {
  const storageKey = DEMO_STORAGE_PREFIX + rootId + ":" + conversationPath;
  const { snapshot, error: readError, refresh: refreshReplies } = useWorkspace(repliesPath);
  const config = parseDemoReplies(snapshot?.file?.data);
  const configError = repliesPath ? readError || (snapshot && !config ? "The sample reply file is not valid. Check its demo-replies structure." : "") : "";
  // On the hub the conversation's new turns live in a shared log beside it.
  const log = useWorkspace(hub && conversationPath ? chatLogPath(conversationPath) : undefined);
  const logContent = log.snapshot?.file?.content;
  const logTurns = useMemo(() => parseChatLog(logContent ?? ""), [logContent]);
  const logError = hub && log.error && !log.missing ? log.error : "";
  const [outbox, setOutbox] = useState<ChatTurn[]>([]);
  const [sendError, setSendError] = useState("");
  const [session, setSession] = useState<{ path: string | undefined; messages: DemoMessage[]; draft: string }>({ path: undefined, messages: [], draft: "" });
  const [pending, setPending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sending = useRef(false);
  const stop = useCallback(() => { clearTimeout(timer.current); sending.current = false; setPending(false); }, []);
  const refreshLog = log.refresh;
  const refresh = useCallback(() => { refreshReplies(); refreshLog(); }, [refreshReplies, refreshLog]);
  const hubMode = !!hub;

  useEffect(() => {
    stop();
    setOutbox([]);
    setSendError("");
    if (conversationPath === undefined) return;
    let restored = { messages: [] as DemoMessage[], draft: "" };
    try { restored = restoreDemoSession(JSON.parse(sessionStorage.getItem(storageKey) || "null")); } catch { /* Session storage may be blocked or contain invalid data. */ }
    setSession({ path: conversationPath, messages: hubMode ? [] : restored.messages, draft: restored.draft });
    return () => { clearTimeout(timer.current); sending.current = false; };
  }, [conversationPath, stop, storageKey, hubMode]);

  useEffect(() => {
    if (conversationPath === undefined || session.path !== conversationPath) return;
    try { sessionStorage.setItem(storageKey, JSON.stringify({ version: 1, messages: session.messages, draft: session.draft })); } catch { /* Keep the demo usable without storage. */ }
  }, [session, conversationPath, storageKey]);

  // A turn leaves the outbox once the hub's log shows it.
  useEffect(() => {
    if (!outbox.length) return;
    const saved = new Set(logTurns.map(turn => turn.id));
    if (outbox.some(turn => saved.has(turn.id))) setOutbox(current => current.filter(turn => !saved.has(turn.id)));
  }, [logTurns, outbox]);

  const sessionReady = conversationPath !== undefined && session.path === conversationPath;
  const error = configError || logError || (hub?.blocked ?? "");
  const ready = sessionReady && !error && (hub ? !!log.snapshot || log.missing : !!config);
  const messages: ChatTurn[] = !sessionReady ? [] : hub
    ? [...logTurns, ...outbox.filter(turn => !logTurns.some(saved => saved.id === turn.id))].map(turn => ({ ...turn, time: shortTime(turn.time) }))
    : session.messages;
  const draft = sessionReady ? session.draft : "";
  function setDraft(value: string) { if (sessionReady) setSession(current => ({ ...current, draft: value.slice(0, MAX_MESSAGE_LENGTH) })); }

  async function save(turn: ChatTurn): Promise<boolean> {
    setOutbox(current => [...current, turn]);
    try {
      const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: conversationPath, messages: [turn] }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "The message was not saved.");
      setSendError("");
      refreshLog();
      return true;
    } catch (cause) {
      setOutbox(current => current.filter(item => item.id !== turn.id));
      setSendError(cause instanceof Error ? cause.message : "The message was not saved.");
      return false;
    }
  }

  async function sendToHub(text: string) {
    const path = conversationPath;
    sending.current = true;
    setPending(!!config);
    setSession(current => ({ ...current, draft: "" }));
    if (!(await save({ id: crypto.randomUUID(), role: "user", content: text }))) {
      setSession(current => current.path === path ? { ...current, draft: current.draft || text } : current);
      stop();
      return;
    }
    // Without sample replies, whoever answers on the hub (a person or an agent) appends the reply.
    if (!config) { sending.current = false; return; }
    const response = sampleReply(text, config);
    timer.current = setTimeout(() => {
      void save({ id: crypto.randomUUID(), role: "assistant", content: response.content.slice(0, MAX_MESSAGE_LENGTH), links: response.links }).finally(() => { sending.current = false; setPending(false); });
    }, 650);
  }

  function send(prompt = draft) {
    const text = prompt.trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!ready || !text || sending.current) return;
    if (hub) { void sendToHub(text); return; }
    const response = sampleReply(text, config!);
    sending.current = true;
    setPending(true);
    setSession(current => ({ ...current, draft: "", messages: [...current.messages, { id: crypto.randomUUID(), role: "user", content: text } as DemoMessage].slice(-MAX_DEMO_MESSAGES) }));
    timer.current = setTimeout(() => {
      setSession(current => current.path === conversationPath ? { ...current, messages: [...current.messages, { id: crypto.randomUUID(), role: "assistant", content: response.content.slice(0, MAX_MESSAGE_LENGTH), links: response.links } as DemoMessage].slice(-MAX_DEMO_MESSAGES) } : current);
      sending.current = false;
      setPending(false);
    }, 650);
  }
  // The hub's history is shared with other devices and agents, so only the browser-local demo resets.
  function reset() { stop(); if (sessionReady && !hub) setSession({ path: conversationPath, messages: [], draft: "" }); }
  return { ready, messages, draft, setDraft, send, stop, reset, pending, error, sendError, refresh, suggestions: config?.suggestions || [], hub, sampleReplies: !!config };
}
