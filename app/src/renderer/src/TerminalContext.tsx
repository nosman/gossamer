import { createContext, useContext } from "react";

export interface TerminalTab {
  id: string;
  label: string;
  cwd?: string;
}

export interface TerminalContextValue {
  /** Open a new terminal tab (or focus an existing one with the same id) and navigate to /terminal */
  openTerminal: (options?: { id?: string; label?: string; cwd?: string }) => void;
}

export const TerminalContext = createContext<TerminalContextValue>({
  openTerminal: () => {},
});

export function useTerminal() {
  return useContext(TerminalContext);
}
