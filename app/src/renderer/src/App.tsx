import React from "react";
import { BreadcrumbProvider } from "./BreadcrumbContext";
import { TabsProvider, parseInitialTab } from "./TabsContext";
import { Shell } from "./Shell";

// Parse initial tab from window URL (used when Electron opens a dedicated window)
const urlTabParam = new URLSearchParams(window.location.search).get("tab");
const initialTab = parseInitialTab(urlTabParam);

export default function App() {
  return (
    <BreadcrumbProvider>
      <TabsProvider initialTab={initialTab}>
        <Shell />
      </TabsProvider>
    </BreadcrumbProvider>
  );
}
