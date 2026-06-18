// xterm wrapper over the shell daemon's exec verbs. Two modes:
//   constrained (allow_exec=false): each line is a one-shot its_invoke; no
//     persistent shell process exists on the station.
//   full (allow_exec=true): exec_start spawns the station's default shell and
//     stays attached; keystrokes go to exec_stdin.
// Both stream output on `its.its-shell.<station>.exec.<id>.output`.

import { useEffect, useRef, useState } from 'preact/hooks';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import {
  commands,
  subscribeHistory,
  useCommand,
  useSetting,
} from '@its/sdk-react';
import '@xterm/xterm/css/xterm.css';
import './Terminal.css';

type Mode = 'constrained' | 'full';

const PROMPT_CONSTRAINED = '\x1b[33mits>\x1b[0m ';
const PROMPT_FULL = '\x1b[36m$\x1b[0m ';

// Light overrides the full ANSI set with darkened equivalents so colored
// output stays readable on white; dark uses xterm's defaults.
const DARK_THEME = {
  background: '#0a0a0a',
  foreground: '#e0e0e0',
  cursor: '#ffffff',
};
const LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#0a0a0c',
  cursor: '#000000',
  black: '#000000',
  red: '#c41a1a',
  green: '#0a8042',
  yellow: '#8a5500',
  blue: '#1c5ec7',
  magenta: '#8b2c8b',
  cyan: '#0a7b8a',
  white: '#4a4a52',
  brightBlack: '#6c6c75',
  brightRed: '#e02020',
  brightGreen: '#0fa258',
  brightYellow: '#aa6a00',
  brightBlue: '#2a7ee0',
  brightMagenta: '#a83ab1',
  brightCyan: '#0fa1b5',
  brightWhite: '#0a0a0c',
};

export function Terminal({
  station,
  mode,
  cmd,
}: {
  station: string;
  mode: Mode;
  cmd?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const inputBufRef = useRef<string>('');
  const execIdRef = useRef<string | null>(null);
  const [error, setError] = useState<string>('');
  const [execId, setExecId] = useState<string>('');

  const itsInvoke = useCommand(commands.itsShell.itsInvoke(station));
  const execStart = useCommand(commands.itsShell.execStart(station));
  const execStdin = useCommand(commands.itsShell.execStdin(station));
  const execStop = useCommand(commands.itsShell.execStop(station));

  const [lightMode] = useSetting<boolean>('global', 'lightMode', false);

  useEffect(() => {
    if (!hostRef.current) return;

    const xt = new XTerm({
      theme: lightMode ? LIGHT_THEME : DARK_THEME,
      fontFamily: 'ui-monospace, Consolas, "Cascadia Mono", monospace',
      fontSize: 13,
      cursorBlink: true,
      convertEol: true,
    });
    const fit = new FitAddon();
    xt.loadAddon(fit);
    xt.open(hostRef.current);
    fit.fit();
    xt.focus();
    xtermRef.current = xt;
    fitRef.current = fit;

    // Click anywhere in the terminal to grab focus back.
    const host = hostRef.current;
    const onClick = () => xt.focus();
    host.addEventListener('click', onClick);

    const onResize = () => fit.fit();
    window.addEventListener('resize', onResize);

    // eslint-disable-next-line no-console
    console.log(`[console] mounted xterm for station=${station} mode=${mode}`);

    xt.writeln(
      `\x1b[90m[${station} · ${mode === 'constrained' ? 'ITS-ONLY' : 'FULL EXEC'}]\x1b[0m`,
    );
    if (mode === 'constrained') {
      xt.writeln(
        `\x1b[90mtype \`its <subcommand>\`; arbitrary shell disabled.\x1b[0m`,
      );
      xt.write(PROMPT_CONSTRAINED);
    } else {
      const shellCmd = cmd || defaultShell();
      xt.writeln(`\x1b[90mstarting: ${shellCmd}\x1b[0m`);
      execStart({ cmd: shellCmd }).then((r) => {
        if (r.error) {
          setError(r.error);
          xt.writeln(`\x1b[31merror: ${r.error}\x1b[0m`);
          return;
        }
        execIdRef.current = r.exec_id;
        setExecId(r.exec_id);
        // Echo suppression comes from the `cmd.exe /Q` in defaultShell().
      }).catch((e) => setError(String(e)));
    }

    return () => {
      window.removeEventListener('resize', onResize);
      host.removeEventListener('click', onClick);
      if (execIdRef.current) {
        execStop({ exec_id: execIdRef.current }).catch(() => undefined);
      }
      xt.dispose();
    };
    // Re-init only on station/mode/cmd change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [station, mode, cmd]);

  // Live theme swap: xterm repaints next frame off .options.theme.
  useEffect(() => {
    const xt = xtermRef.current;
    if (!xt) return;
    xt.options.theme = lightMode ? LIGHT_THEME : DARK_THEME;
  }, [lightMode]);

  useEffect(() => {
    const xt = xtermRef.current;
    if (!xt) return;

    const disp = xt.onData((data: string) => {
      // eslint-disable-next-line no-console
      console.log(`[console] keystroke mode=${mode} data=${JSON.stringify(data)} execId=${execIdRef.current}`);
      if (mode === 'constrained') {
        // Line-buffered: echo locally, submit the whole line to its_invoke on Enter.
        for (const ch of data) {
          if (ch === '\r' || ch === '\n') {
            const line = inputBufRef.current;
            inputBufRef.current = '';
            xt.write('\r\n');
            submitConstrained(line);
          } else if (ch === '\x7f' || ch === '\b') {
            if (inputBufRef.current.length > 0) {
              inputBufRef.current = inputBufRef.current.slice(0, -1);
              xt.write('\b \b');
            }
          } else if (ch >= ' ') {
            inputBufRef.current += ch;
            xt.write(ch);
          }
        }
      } else {
        // Full mode: line-buffer locally (backspace works; no partial chars to
        // a non-echoing shell), send the whole line + \n on Enter. v1 is
        // line-only; per-char TUI interactivity needs PTY support.
        if (!execIdRef.current) return;
        for (const ch of data) {
          if (ch === '\r' || ch === '\n') {
            const line = inputBufRef.current;
            inputBufRef.current = '';
            xt.write('\r\n');
            execStdin({ exec_id: execIdRef.current, chunk: line + '\n' });
          } else if (ch === '\x7f' || ch === '\b') {
            if (inputBufRef.current.length > 0) {
              inputBufRef.current = inputBufRef.current.slice(0, -1);
              xt.write('\b \b');
            }
          } else if (ch >= ' ') {
            inputBufRef.current += ch;
            xt.write(ch);
          }
        }
      }
    });
    return () => disp.dispose();
  }, [mode]);

  async function submitConstrained(line: string): Promise<void> {
    const trimmed = line.trim();
    const xt = xtermRef.current!;
    if (!trimmed) {
      xt.write(PROMPT_CONSTRAINED);
      return;
    }
    const argv = parseArgv(trimmed);
    if (argv[0] === 'its') argv.shift();  // tolerate optional leading "its"
    try {
      const r = await itsInvoke({ argv });
      const eid = r.exec_id;
      execIdRef.current = eid;
      const unsub = subscribeHistory(
        `its.its-shell.${station}.exec.${eid}.output`,
        (buf) => {
          // Emit only entries since last render; index by length.
          const last = (xt as any).__seenLen ?? 0;
          for (const entry of (buf as { type: string; data: string }[]).slice(last)) {
            if (entry.type === 'exit') {
              // Force the exit marker onto its own line in case the last chunk
              // had no trailing newline.
              xt.write(`\r\n\x1b[90m[exit ${entry.data}]\x1b[0m\r\n`);
              xt.write(PROMPT_CONSTRAINED);
              unsub();
              (xt as any).__seenLen = 0;
              execIdRef.current = null;
              return;
            }
            const color = entry.type === 'stderr' ? '\x1b[31m' : '';
            const reset = color ? '\x1b[0m' : '';
            xt.write(`${color}${entry.data}${reset}`);
          }
          (xt as any).__seenLen = buf.length;
        },
      );
    } catch (e) {
      xt.writeln(`\x1b[31merror: ${e}\x1b[0m`);
      xt.write(PROMPT_CONSTRAINED);
    }
  }

  // Full-mode output pipe. Constrained mode subscribes per-invocation instead.
  useEffect(() => {
    if (mode !== 'full') return;
    const xt = xtermRef.current;
    if (!xt) return;
    const subject = `its.its-shell.${station}.exec.*.output`;
    let lastSeen = 0;
    // eslint-disable-next-line no-console
    console.log(`[console] full-mode subscribing to ${subject}`);
    const unsub = subscribeHistory(subject, (buf) => {
      for (const entry of (buf as { type: string; data: string }[]).slice(lastSeen)) {
        if (entry.type === 'exit') {
          xt.writeln(`\r\n\x1b[90m[shell exited ${entry.data}; close + reopen the tab to restart]\x1b[0m`);
        } else {
          xt.write(entry.data);
        }
      }
      lastSeen = buf.length;
    });
    return () => unsub();
  }, [station, mode]);

  return (
    <div class="console-terminal-wrap">
      {error && <div class="console-terminal-error">{error}</div>}
      <div class="console-terminal-host" ref={hostRef} />
    </div>
  );
}

function defaultShell(): string {
  // `cmd.exe /Q` disables echo for the whole interactive session (`@echo off`
  // only works inside batch files), so our local echo is the only source.
  // Override with `?cmd=` for PowerShell or bash.
  return navigator.userAgent.toLowerCase().includes('windows')
    ? 'cmd.exe /Q'
    : 'bash';
}

function parseArgv(line: string): string[] {
  // Minimal splitter: spaces split, double quotes group. Complex quoting
  // belongs in full exec mode.
  const out: string[] = [];
  let buf = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ' ' && !inQuotes) {
      if (buf) {
        out.push(buf);
        buf = '';
      }
    } else {
      buf += ch;
    }
  }
  if (buf) out.push(buf);
  return out;
}
