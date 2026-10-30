import type { Config } from "tailwindcss";

// VibeDeck design tokens — the Vibe webapp palette (neutral charcoal + Mistral orange).
const config: Config = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "hsl(var(--background))",
        surface: "hsl(var(--card))",
        "surface-raised": "hsl(var(--popover))",
        "surface-muted": "hsl(var(--muted))",
        border: "hsl(var(--border))",
        "border-strong": "hsl(var(--input))",
        text: "hsl(var(--foreground))",
        "text-muted": "hsl(var(--muted-foreground))",
        "text-faint": "hsl(var(--text-faint))",
        primary: "hsl(var(--primary))",
        "primary-hover": "hsl(var(--primary-hover))",
        "primary-press": "hsl(var(--primary-press))",
        "primary-foreground": "hsl(var(--primary-foreground))",
        accent: "hsl(var(--accent))",
        "accent-foreground": "hsl(var(--accent-foreground))",
        danger: "hsl(var(--destructive))",
        success: "hsl(142 60% 42%)",
        warning: "hsl(38 92% 50%)",
        info: "hsl(199 89% 48%)",
        sidebar: "hsl(var(--sidebar-background))",
        "sidebar-border": "hsl(var(--sidebar-border))",
        "sidebar-accent": "hsl(var(--sidebar-accent))",
        code: "hsl(var(--code-background))",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        xl: "0.875rem",
      },
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        blink: { "0%,100%": { opacity: "1" }, "50%": { opacity: "0.25" } },
      },
      animation: {
        "fade-in": "fade-in 160ms ease-out",
        "slide-up": "slide-up 200ms ease-out",
        blink: "blink 1.1s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
