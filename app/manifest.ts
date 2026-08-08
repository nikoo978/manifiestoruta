import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Ruta Envíos",
    short_name: "Ruta Envíos",
    description: "Planificador de reparto con carga manual, PDF e imágenes.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f5f6f4",
    theme_color: "#17663d",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}
