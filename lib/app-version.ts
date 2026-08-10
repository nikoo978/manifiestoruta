export const APP_VERSION = "2.5.2";
export const SERVICE_WORKER_VERSION = "v23";

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
  title: "Tema oscuro y corredor ampliado con callejero enriquecido",
  releasedAt: "2026-08-10",
  previousFeatures: [
    "OCR Rápido e Intenso con progreso visible.",
    "Carga de direcciones manuales, PDF e imágenes.",
    "Ruta única con geocodificación, edición, PWA offline y fuente original.",
    "Callejero oficial versionado y actualización manual reproducible."
  ],
  changes: [
    "Añade tema oscuro persistente con botón de sol en tema claro y luna en tema oscuro.",
    "Añade Agustina, Tiburcio (Fortín Tiburcio), Arenales, Arribeños y Teodelina; conserva Junín, Ascensión y Ferré y las localidades anteriores.",
    "Restaura Teodelina a su jurisdicción correcta: Santa Fe / General López, anulando la corrección territorial errónea de la versión anterior.",
    "El actualizador descarga el listado completo de calles de cada localidad soportada y conserva altura mínima/máxima, rangos por lado, nomenclatura, categoría, jurisdicción, fuente y centro geométrico cuando está disponible.",
    "OCR marca para revisión las alturas que quedan fuera del rango oficial de una calle.",
    "La exportación de callejeros incluye provincia, rangos por lado, fuente y coordenadas de referencia.",
    "Service Worker v23 fuerza la actualización limpia de la PWA."
  ]
} as ReleaseInfo;
