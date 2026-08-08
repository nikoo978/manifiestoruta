import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Ruta Envíos · Suite Manifiestos",
    short_name: "Ruta Envíos",
    description: "Planificador de reparto con direcciones libres, PDF sin OCR, imágenes con OCR y mapas por localidad.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f4f7f2",
    theme_color: "#f4f7f2",
    icons: [
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}
