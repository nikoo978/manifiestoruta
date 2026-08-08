import type { Metadata, Viewport } from "next";
import { PwaRegister } from "./pwa-register";
import "./globals.css";
import "./ruta/ruta.css";

export const metadata: Metadata = {
  title: "Ruta Postal · Suite Manifiestos",
  description: "Ruta Envíos con direcciones libres, PDF sin OCR, imágenes con OCR y geocodificación por localidad.",
  applicationName: "Suite Manifiestos",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Ruta Postal · Suite Manifiestos",
  },
  formatDetection: { telephone: false },
  icons: {
    icon: [{ url: "/icons/icon.svg", type: "image/svg+xml" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f4f7f2",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="es"><body><PwaRegister />{children}</body></html>;
}
