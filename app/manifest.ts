import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  const value = {
    id: "/",
    name: "Ruta Envíos · OCR y reparto",
    short_name: "Ruta Envíos",
    description: "Planificador profesional de reparto con manifiestos, Google Maps, PDF y OCR.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#f1f4f1",
    theme_color: "#0b6143",
    lang: "es-AR",
    categories: ["navigation", "productivity", "utilities"],
    shortcuts: [
      { name: "Mi ruta", short_name: "Ruta", description: "Abrir el planificador de reparto", url: "/", icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }] },
      { name: "OCR de manifiesto", short_name: "OCR", description: "Leer un manifiesto desde PDF o imágenes", url: "/ocr", icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }] },
    ],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
  return value as MetadataRoute.Manifest;
}
