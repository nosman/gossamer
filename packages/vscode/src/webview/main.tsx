import React from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider, createTheme } from "@mantine/core";
import "@mantine/core/styles.css";
import "./global.css";
import { App } from "./App";

const theme = createTheme({
  fontFamily: "var(--vscode-font-family), system-ui, sans-serif",
});

function getColorScheme(): "light" | "dark" {
  return document.body.classList.contains("vscode-light") ? "light" : "dark";
}

createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme} forceColorScheme={getColorScheme()}>
    <App />
  </MantineProvider>
);
