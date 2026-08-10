export const APP_VERSION = "2.5.3";
export const SERVICE_WORKER_VERSION = "v24";

export type ReleaseInfo = {
  version: string;
  serviceWorker: string;
  title: string;
  releasedAt: string;
  previousFeatures: string[];
  changes: string[];
};

export const CURRENT_RELEASE: ReleaseInfo = {
  version: APP_VERSION,
  serviceWorker: SERVICE_WORKER_VERSION,
  title: "PWA Android más fluida con carga visible",
  releasedAt: "2026-08-10",
  previousFeatures: [
    "Tema claro/oscuro persistente y PWA offline.",
    "OCR Rápido e Intenso con progreso visible.",
    "Ruta unificada, callejero enriquecido y geocodificación multi-localidad.",
    "Fuente original por parada y edición manual de direcciones/coordenadas."
  ],
  changes: [
    "Mantiene Leaflet montado y actualiza sólo las capas de ruta, evitando recargar mapa y mosaicos ante cambios de estado.",
    "Difiere la persistencia en localStorage al tiempo ocioso para evitar bloqueos del hilo principal.",
    "Evita recalcular la optimización O(n²) cuando sólo cambia el estado, nombre o notas de una parada.",
    "Reduce trabajo de análisis visual de imágenes en Android y cede periódicamente el hilo principal durante el postprocesado OCR.",
    "Añade un indicador global de trabajo con spinner, etapa y porcentaje para OCR, PDF, geocodificación, GPS y carga inicial.",
    "Reduce blur, sombras y transiciones costosas en pantallas móviles y omite pintura/layout de tarjetas fuera del viewport.",
    "Reduce la resolución de render del visor PDF en dispositivos de menor potencia sin modificar el archivo original.",
    "Service Worker v24 fuerza la actualización de los recursos PWA."
  ]
} as ReleaseInfo;
