import React, { createContext, useContext, useState } from "react";

export interface Crumb {
  label: string;
  path?: string;
  /** If set, clicking the crumb copies this value to clipboard. */
  copyValue?: string;
}

interface BreadcrumbCtx {
  crumbs: Crumb[];
  setCrumbs: (crumbs: Crumb[]) => void;
}

const BreadcrumbContext = createContext<BreadcrumbCtx>({ crumbs: [], setCrumbs: () => {} });

export function BreadcrumbProvider({ children }: { children: React.ReactNode }) {
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  return (
    <BreadcrumbContext.Provider value={{ crumbs, setCrumbs }}>
      {children}
    </BreadcrumbContext.Provider>
  );
}

export function useBreadcrumb() {
  return useContext(BreadcrumbContext);
}
