/**
 * Thin shims replacing react-native primitives with HTML equivalents.
 * Style objects are compatible — React DOM accepts the same camelCase CSS
 * properties with numeric pixel values.
 */
import React from "react";

type AnyStyle = React.CSSProperties | AnyStyle[] | undefined | null | false;

function flat(style: AnyStyle): React.CSSProperties {
  if (!style) return {};
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flat));
  return style as React.CSSProperties;
}

// ── View ──────────────────────────────────────────────────────────────────────
// RN View is flex-column by default.
interface ViewProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "style"> {
  style?: AnyStyle;
}
export function View({ style, children, ...props }: ViewProps) {
  return (
    <div
      style={{ display: "flex", flexDirection: "column", ...flat(style) }}
      {...props}
    >
      {children}
    </div>
  );
}

// ── Text ──────────────────────────────────────────────────────────────────────
// Renders as div (block). Use `span` directly for inline contexts (MarkdownView).
interface TextProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "style"> {
  style?: AnyStyle;
  numberOfLines?: number;
  selectable?: boolean;
}
export function Text({ style, children, numberOfLines, selectable, ...props }: TextProps) {
  const base = flat(style);
  if (numberOfLines === 1) {
    base.overflow = "hidden";
    base.textOverflow = "ellipsis";
    base.whiteSpace = "nowrap";
  }
  if (selectable) base.userSelect = "text";
  return (
    <div style={base} {...props}>
      {children}
    </div>
  );
}

// ── TouchableOpacity / Pressable ──────────────────────────────────────────────
interface PressableProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "style" | "onClick"> {
  style?: AnyStyle;
  onPress?: () => void;
  activeOpacity?: number;
  hitSlop?: unknown;
}
export function TouchableOpacity({ style, onPress, children, activeOpacity, hitSlop, ...props }: PressableProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onPress}
      onKeyDown={(e) => e.key === "Enter" && onPress?.()}
      style={{ cursor: "pointer", ...flat(style) }}
      {...props}
    >
      {children}
    </div>
  );
}
export const Pressable = TouchableOpacity;

// ── StyleSheet ────────────────────────────────────────────────────────────────
export const StyleSheet = {
  create: <T extends Record<string, React.CSSProperties>>(styles: T): T => styles,
};

// ── ActivityIndicator ─────────────────────────────────────────────────────────
export function ActivityIndicator({
  color = "#6366f1",
}: {
  color?: string;
  size?: string | number;
}) {
  return (
    <div
      style={{
        width: 32,
        height: 32,
        borderRadius: "50%",
        border: "3px solid #e5e7eb",
        borderTopColor: color,
        animation: "spin 0.8s linear infinite",
        alignSelf: "center",
        margin: "auto",
      }}
    />
  );
}

// ── useWindowDimensions ───────────────────────────────────────────────────────
export function useWindowDimensions() {
  return { width: window.innerWidth, height: window.innerHeight };
}

// ── Linking ───────────────────────────────────────────────────────────────────
export const Linking = {
  openURL: (url: string) => window.open(url, "_blank"),
};
