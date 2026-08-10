import type { Metadata, Viewport } from "next";
import { PwaRegister } from "./pwa-register";
import "./globals.css";
import "./ruta/ruta.css";

export const metadata: Metadata = {
  title: "Ruta Envíos",
  description: "Planificador de reparto con carga manual, PDF e imágenes.",
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
  viewportFit: "cover",
  themeColor: "#17663d",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="es"><body><PwaRegister />{children}</body></html>;
}
