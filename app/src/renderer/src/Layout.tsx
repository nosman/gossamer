import React from "react";
import { Outlet, useNavigate, useLocation } from "react-router-dom";

function useRouteTitle(): string {
  const { pathname, state } = useLocation();
  const s = state as { title?: string } | null;
  if (s?.title) return s.title;
  if (pathname === "/") return "Claude Sessions";
  if (pathname === "/session-tree") return "Session Tree";
  if (pathname === "/checkpoints") return "Checkpoints";
  if (pathname === "/checkpoints/timeline") return "Checkpoint Timeline";
  if (pathname.startsWith("/sessions/")) return "Session Detail";
  if (pathname.startsWith("/checkpoints/")) return "Checkpoint Detail";
  return "Gossamer";
}

function HeaderRight() {
  const { pathname } = useLocation();
  const navigate = useNavigate();

  if (pathname === "/") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <button
          onClick={() => navigate("/checkpoints")}
          title="Checkpoints"
          style={btnStyle}
        >
          ⬛
        </button>
        <button
          onClick={() => navigate("/session-tree")}
          title="Session Tree"
          style={btnStyle}
        >
          ⬡
        </button>
      </div>
    );
  }

  if (pathname === "/checkpoints") {
    return (
      <button
        onClick={() => navigate("/checkpoints/timeline")}
        title="Timeline"
        style={btnStyle}
      >
        ◎
      </button>
    );
  }

  return null;
}

const btnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  fontSize: 18,
  padding: "4px 8px",
  color: "#374151",
  borderRadius: 4,
  lineHeight: 1,
};

export function Layout() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const title = useRouteTitle();
  const canGoBack = pathname !== "/";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: 48,
          paddingLeft: 12,
          paddingRight: 12,
          backgroundColor: "#f9fafb",
          borderBottom: "1px solid #e5e7eb",
          flexShrink: 0,
        }}
      >
        {canGoBack && (
          <button
            onClick={() => navigate(-1)}
            style={{ ...btnStyle, fontSize: 16, marginRight: 4 }}
            title="Back"
          >
            ←
          </button>
        )}
        <span
          style={{
            flex: 1,
            fontSize: 14,
            fontWeight: 600,
            color: "#111827",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </span>
        <HeaderRight />
      </div>

      {/* Content */}
      <main
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <Outlet />
      </main>
    </div>
  );
}
