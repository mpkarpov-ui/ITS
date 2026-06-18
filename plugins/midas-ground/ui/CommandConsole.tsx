// Modal terminal that broadcasts a raw MShell line to every connected feather
// and shows each one's result. Send: commands.issFeather.mshell() (broadcast on
// its.cmd.iss-feather.mshell). Receive: each feather's CmdResult on
// its.iss-feather.<channel>.cmd_result, folded back into the transcript by cmd_id.

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  commands,
  subjects,
  subscribe,
  useCommand,
  useKnownSubjects,
} from '@its/sdk-react';
import './CommandConsole.css';

// cmd_result payload, straight off the bus (snake_case per the Pydantic schema).
interface CmdResultMsg {
  cmd_id: string | null;
  line: string;
  ok: boolean;
  replies: string[];
  received_ms: number;
}

interface FeatherResult {
  channel: string;
  ok: boolean;
  replies: string[];
}

interface ConsoleEntry {
  cmdId: string;
  line: string;
  sentAtMs: number;
  dangerous: boolean;
  results: FeatherResult[];
}

// Verbs that move pyro / flight state. Flagged with a warning, not a
// confirmation gate (the view is already PIN-gated).
const DANGEROUS_VERBS = new Set(['fire', 'arm', 'pt']);

export function isDangerous(line: string): boolean {
  const verb = line.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return DANGEROUS_VERBS.has(verb);
}

export interface ConsoleApi {
  transcript: ConsoleEntry[];
  reach: string[];
  sendLine: (line: string) => void;
  clear: () => void;
}

// Owns the transcript + cmd_result subscription. Lives in CommandingView (not
// the modal) so results keep landing while the window opens and closes.
export function useCommandConsole(): ConsoleApi {
  const broadcast = useCommand(commands.issFeather.mshell());
  const [transcript, setTranscript] = useState<ConsoleEntry[]>([]);

  // Connected feathers = distinct channel segments of live tlm subjects
  // (its.iss-feather.<channel>.<serial>.tlm). Drives the reach indicator.
  const knownTlm = useKnownSubjects('its.iss-feather.*.*.tlm');
  const reach = useMemo(() => {
    const channels = new Set<string>();
    for (const key of knownTlm) {
      const seg = key.split('.');
      if (seg.length === 5 && seg[2] && seg[2] !== '*') channels.add(seg[2]);
    }
    return [...channels].sort();
  }, [knownTlm]);

  // Fold each feather's result into its originating entry, keyed by cmd_id.
  useEffect(() => {
    return subscribe(subjects.issFeather.cmdResult(), (payload, concrete) => {
      const r = payload as CmdResultMsg;
      const channel = concrete.split('.')[2];
      setTranscript((prev) =>
        prev.map((entry) => {
          if (entry.cmdId !== r.cmd_id) return entry;
          const others = entry.results.filter((x) => x.channel !== channel);
          const results = [...others, { channel, ok: r.ok, replies: r.replies }].sort(
            (a, b) => a.channel.localeCompare(b.channel),
          );
          return { ...entry, results };
        }),
      );
    });
  }, []);

  const sendLine = useCallback(
    (raw: string) => {
      const line = raw.trim();
      if (!line) return;
      const cmdId =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setTranscript((prev) => [
        ...prev,
        { cmdId, line, sentAtMs: Date.now(), dangerous: isDangerous(line), results: [] },
      ]);
      broadcast({ line, cmd_id: cmdId });
    },
    [broadcast],
  );

  const clear = useCallback(() => setTranscript([]), []);
  return { transcript, reach, sendLine, clear };
}

export function CommandConsole({
  open,
  onClose,
  api,
}: {
  open: boolean;
  onClose: () => void;
  api: ConsoleApi;
}) {
  const { transcript, reach, sendLine, clear } = api;
  const [input, setInput] = useState('');
  // Index into previously-sent lines for Up/Down recall; null = editing fresh.
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const sentLines = useMemo(() => transcript.map((e) => e.line), [transcript]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Keep the transcript pinned to the newest line.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript, open]);

  if (!open) return null;

  const danger = isDangerous(input);

  const submit = () => {
    sendLine(input);
    setInput('');
    setHistIdx(null);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'ArrowUp') {
      if (sentLines.length === 0) return;
      e.preventDefault();
      const idx = histIdx === null ? sentLines.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(idx);
      setInput(sentLines[idx]);
    } else if (e.key === 'ArrowDown') {
      if (histIdx === null) return;
      e.preventDefault();
      if (histIdx >= sentLines.length - 1) {
        setHistIdx(null);
        setInput('');
      } else {
        const idx = histIdx + 1;
        setHistIdx(idx);
        setInput(sentLines[idx]);
      }
    }
  };

  return (
    <div class="cc-overlay" onClick={onClose}>
      <div class="cc-window" onClick={(e) => e.stopPropagation()}>
        <header class="cc-header">
          <span class="cc-title">Feather Console</span>
          <span class="cc-reach">
            {reach.length === 0
              ? 'no feathers connected'
              : `broadcasting to ${reach.length} feather${reach.length === 1 ? '' : 's'}: ${reach.join(', ')}`}
          </span>
          <div class="cc-header-actions">
            <button class="cc-btn" onClick={clear}>
              Clear
            </button>
            <button class="cc-btn cc-close" onClick={onClose} aria-label="Close console">
              ✕
            </button>
          </div>
        </header>

        <div class="cc-transcript" ref={scrollRef}>
          {transcript.length === 0 && (
            <div class="cc-empty">
              Broadcast a raw MShell line to every connected feather. Try{' '}
              <code>ident</code>, <code>frequency 0 get</code>, or <code>safe 42</code>.
            </div>
          )}
          {transcript.map((e) => (
            <div key={e.cmdId} class={`cc-entry${e.dangerous ? ' cc-entry-danger' : ''}`}>
              <div class="cc-cmdline">
                <span class="cc-prompt">›</span>
                <span class="cc-cmdtext">{e.line}</span>
              </div>
              {e.results.length === 0 ? (
                <div class="cc-waiting">waiting for feathers…</div>
              ) : (
                e.results.map((r) => (
                  <div key={r.channel} class={`cc-result${r.ok ? '' : ' cc-result-fail'}`}>
                    <span class="cc-ch">{r.channel}</span>
                    <span class="cc-mark">{r.ok ? '✓' : '✗'}</span>
                    <span class="cc-replies">{r.replies.join('   ') || '(no reply)'}</span>
                  </div>
                ))
              )}
            </div>
          ))}
        </div>

        {danger && (
          <div class="cc-warning">
            Detecting a dangerous command: please make sure you are following all
            safety protocols
          </div>
        )}
        <div class="cc-inputrow">
          <span class="cc-prompt">›</span>
          <input
            ref={inputRef}
            class="cc-input"
            type="text"
            spellcheck={false}
            autocomplete="off"
            value={input}
            onInput={(e) => setInput((e.target as HTMLInputElement).value)}
            onKeyDown={onKeyDown}
          />
          <button class="cc-send" onClick={submit} disabled={!input.trim()}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
