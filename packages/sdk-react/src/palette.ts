// Command palette registry. Platform code and plugins register named actions
// that the palette (Ctrl/Cmd+K, or `>` prefix) runs. The store is a page-global
// singleton; most commands register at module load, while view-scoped ones
// register in a useEffect and unregister on cleanup.

export interface PaletteCommand {
  // Stable id, '<plugin-id>.<verb>'. Used to de-dupe re-registration on reload.
  id: string;
  title: string;
  hint?: string;
  // Owning plugin. The command only shows while a route owned by that plugin
  // is active. Omit for platform-wide commands (e.g. theme toggle).
  source?: string;
  // Defaults true. Set false for real actions that shouldn't clutter the list
  // (e.g. nav commands discoverable via the tab switcher); they still run via
  // shortcut and programmatically.
  showInPalette?: boolean;
  // Display-only shortcut hint. The palette does NOT bind it; the command's
  // owner listens for the keys.
  shortcut?: string;
  // May be async; the palette closes immediately and the promise runs detached.
  action: () => void | Promise<void>;
}

const commands = new Map<string, PaletteCommand>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

// Returns an unregister fn. Re-registering the same id overwrites, so hot
// reload doesn't leave duplicates.
export function registerCommand(cmd: PaletteCommand): () => void {
  commands.set(cmd.id, cmd);
  notify();
  return () => {
    if (commands.delete(cmd.id)) notify();
  };
}

export function getPaletteCommands(): PaletteCommand[] {
  return Array.from(commands.values());
}

export function subscribePaletteCommands(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
