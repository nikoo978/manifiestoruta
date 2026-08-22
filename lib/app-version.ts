export const APP_VERSION = "2.6.0";
export const SERVICE_WORKER_VERSION = "v26";

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
  title: "Google Maps y centro operativo móvil",
  releasedAt: "2026-08-22",
  previousFeatures: [
    "Tema claro/oscuro persistente y PWA optimizada para iPhone y Android.",
    "Indicador global de trabajo con progreso visible.",
    "Ruta unificada, callejero enriquecido y geocodificación multi-localidad.",
    "Fuente original por parada y edición manual de direcciones/coordenadas."
  ],
  changes: [
    "Reemplaza Leaflet y OpenStreetMap por Google Maps vectorial, cargado sólo al desplegar el mapa.",
    "Muestra marcadores avanzados numerados, accesibles y con ficha de destinatario.",
    "Routes API dibuja el recorrido vial y calcula distancia y tiempo; si no está habilitada, conserva una vista estimada.",
    "Cada entrega incorpora un botón Ir que abre la navegación de Google Maps en el teléfono.",
    "Renueva toda la interfaz como centro operativo responsive, con resumen de ubicadas, pendientes y entregadas.",
    "Mantiene la lectura directa de PDF, OCR de imágenes, callejero local y geocodificación gratuita existentes.",
    "Service Worker v26 fuerza la actualización de la PWA."
  ]
} as ReleaseInfo;
