# Ruta Envíos

Versión 1.7.0. Ruta Envíos es la interfaz principal para preparar repartos por localidad.

## Carga

- Direcciones libres, una por línea. Ej.: `Rivadavia 40 Junín`.
- Cruces y entrecalles. Ej.: `Arias entre Cabrera y Quintana Junín`.
- PDF con lectura de texto, sin OCR.
- Imágenes con OCR automático.
- Arrastrar y soltar PDF o imágenes.

## Mapa

La aplicación intenta ubicar cada parada con Georef Argentina, Photon/OpenStreetMap y los fallbacks de calles/intersecciones. Si una dirección queda pendiente, permite abrirla en Google Maps y pegar coordenadas manuales (`lat, lon` o una URL que las contenga).

Los envíos se agrupan por localidad y sólo se muestra un mapa por vez.

## PWA

La aplicación puede instalarse como PWA. En iPhone/iPad: Compartir → Agregar a Inicio.

## Rutas

- `/` — Ruta Envíos.
- `/ocr` y `/ruta` — compatibilidad; redirigen a `/`.
- `/api/scan` — OCR de imágenes.
- `/api/geocode` — geocodificación.
- `/api/calles` — catálogo de calles.

## Variables

```env
GOOGLE_GENERATIVE_AI_API_KEY=
AI_GATEWAY_API_KEY=
SUPABASE_URL=
SUPABASE_SECRET_KEY=
```

La ruta se persiste en `localStorage` y migra versiones anteriores automáticamente.
