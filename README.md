# Ruta Postal · Suite Manifiestos

Versión 1.5.0 de la aplicación unificada. **Ruta Postal es la única interfaz principal** y Manifiesto OCR funciona internamente cuando se cargan imágenes.

## Flujo principal

1. `/` abre **Ruta Postal**.
2. Todos los envíos usan **Nº de paquete · Nombre · Dirección · Localidad · CP**.
3. **PDF:** se extrae su capa de texto con PDF.js y se normaliza sin consumir OCR.
4. **Imágenes:** se envían automáticamente a `/api/scan`; el resultado OCR se incorpora a Ruta Postal sin navegar a otra pantalla.
5. Los envíos se agrupan por localidad. Sólo una localidad se geocodifica y se muestra en el mapa; las demás quedan **En espera**.
6. Al seleccionar la siguiente localidad se carga su mapa y se conserva el resto de la cola.

## Rutas

- `/` — Ruta Postal: PDF, imágenes OCR, tabla manual, cola por localidad, mapas, recorrido y CSV.
- `/ocr` — compatibilidad: redirige a `/`; ya no existe una interfaz OCR separada.
- `/ruta` — compatibilidad: redirige a `/`.
- `/api/scan` — OCR de imágenes con Gemini / Vercel AI Gateway.
- `/api/geocode` — Georef Argentina + Photon/OpenStreetMap + Overpass.
- `/api/calles` — catálogo de calles.

## Variables de Vercel

```env
GOOGLE_GENERATIVE_AI_API_KEY=
AI_GATEWAY_API_KEY=
SUPABASE_URL=
SUPABASE_SECRET_KEY=
```

Las variables permanecen en Vercel. Los PDF no pasan por el OCR.

## Datos locales

La ruta se guarda en `localStorage` como `ruta-postal:v3` y migra datos existentes de `ruta-postal:v2` y `ruta-postal:v1`.
