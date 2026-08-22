import type { Metadata, Viewport } from "next";
import { PwaRegister } from "./pwa-register";
import "./globals.css";
import "./ruta/ruta.css";

export const metadata: Metadata = {
  title: "Ruta Envíos",
  description: "Planificador profesional de reparto con manifiestos, Google Maps y navegación móvil.",
  applicationName: "Ruta Envíos",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Ruta Envíos",
  },
  formatDetection: { telephone: false },
  icons: {
    icon: [{ url: "/icons/icon.svg", type: "image/svg+xml" }, { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }, { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#0b6143" },
    { media: "(prefers-color-scheme: dark)", color: "#0c1310" },
  ],
};

const themeBootstrap = `(()=>{try{const k="ruta-envios-theme";const s=localStorage.getItem(k);const t=s==="light"||s==="dark"?s:(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t;}catch{}})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="es" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: themeBootstrap }} /></head><body><PwaRegister />{children}</body></html>;
}
