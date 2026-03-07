import React from "react";
import ReactDOM from "react-dom/client";
import { MantineProvider, createTheme, localStorageColorSchemeManager } from "@mantine/core";
import "@mantine/core/styles.css";
import App from "./App";

const colorSchemeManager = localStorageColorSchemeManager({ key: "gossamer-color-scheme" });

const theme = createTheme({
  primaryColor: "indigo",
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
  fontFamilyMonospace: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  colors: {
    dark: [
      "#e6edf3", // [0] primary text
      "#8b949e", // [1] muted text
      "#6e7681", // [2]
      "#484f58", // [3]
      "#30363d", // [4] borders
      "#21262d", // [5] elevated surfaces / cards
      "#161b22", // [6] main background
      "#0d1117", // [7] sidebar / deepest bg
      "#010409", // [8]
      "#000000", // [9]
    ],
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MantineProvider theme={theme} colorSchemeManager={colorSchemeManager} defaultColorScheme="dark">
      <App />
    </MantineProvider>
  </React.StrictMode>
);
