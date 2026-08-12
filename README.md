# Ruta Envíos

Versión 2.5.4. Ruta Envíos unifica carga, OCR, geocodificación, mapa y preparación del reparto en una sola PWA.

## Carga

- Direcciones libres, una por línea. Ej.: `Rivadavia 40 Junín`.
- Cruces y entrecalles. Ej.: `Arias entre Cabrera y Quintana Junín`.
- PDF con lectura de texto, sin OCR.
- Imágenes con OCR automático.
- Arrastrar y soltar PDF o imágenes.

## Mapa

La aplicación intenta ubicar cada parada con Georef Argentina, Photon/OpenStreetMap y los fallbacks de calles/intersecciones. Si una dirección queda pendiente, permite abrirla en Google Maps y pegar coordenadas manuales (`lat, lon` o una URL que las contenga).

Todas las localidades pueden optimizarse en una sola ruta y un solo mapa; los chips de localidad funcionan como filtros visuales.

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

## v2.2.0

- OCR seleccionable: **Rápido** para una lectura directa e **Intenso** para comprobaciones adicionales.
- La llamada al modelo OCR ya no usa un timeout artificial del SDK. La infraestructura de Vercel mantiene su propio límite máximo de ejecución.
- El OCR responde por streaming NDJSON con progreso por etapas y latidos periódicos, mostrando porcentaje y tiempo transcurrido.
- La PWA detecta versiones nuevas mediante `version.json`, muestra **Actualizar versión…**, activa el nuevo service worker sólo al confirmarlo y luego presenta un resumen de funciones conservadas y novedades.
- Service worker `ruta-envios-v14`.


## v2.5.2

- Corrección: Teodelina vuelve a Santa Fe / General López; se anula la asignación errónea a Buenos Aires de la versión 2.5.1.
- Tema claro/oscuro persistente (sol/luna) con detección inicial del sistema.
- Localidades prioritarias: Junín, Agustina, Tiburcio, Ascensión, Ferré, Arenales, Arribeños y Teodelina.
- Teodelina se usa en Santa Fe / General López para OCR, callejero y geocodificación.
- `npm run refresh:streets` descarga el callejero completo por localidad desde Georef v2.0 y guarda rangos de altura, lados, categoría, fuente y centro geométrico cuando la API lo informa.
- El catálogo queda versionado en `data/street-catalog.json`; el build de Vercel no depende de Internet.

### Callejero oficial

El archivo `data/street-catalog.json` es el snapshot versionado que usa el OCR sin conexión. Para actualizarlo con Georef v2.0 ejecutá `ACTUALIZAR_CALLEJERO.cmd` en Windows o `npm run refresh:streets` en cualquier sistema con Node.js. El actualizador recorre todas las calles de las localidades configuradas, pagina hasta completar cada localidad y conserva nombre oficial, categoría, rangos de altura por lado, provincia, partido/departamento, localidad, fuente y centro geométrico cuando Georef lo informa.

## v2.5.3

- Optimización específica para Android/PWA: Leaflet permanece montado y sólo redibuja capas de ruta cuando cambia la geometría.
- Persistencia de la ruta diferida con `requestIdleCallback`/timer para evitar escrituras síncronas durante interacciones.
- La optimización del recorrido no vuelve a ejecutarse cuando sólo cambia el estado, nombre o notas de una parada.
- Postprocesado de imágenes reducido en teléfonos y dividido en pequeños turnos para mantener vivo el hilo de interfaz.
- Indicador global de trabajo con spinner, etapa y porcentaje para carga inicial, OCR, PDF, geocodificación y GPS.
- Menos blur, sombras y transiciones costosas en móvil; tarjetas fuera de pantalla usan `content-visibility`.
- Visor PDF usa una escala menor en dispositivos de menor potencia, preservando el original.
- Service Worker `v24`.


## v2.5.4

- Mapa plegado y lazy: Leaflet/tiles sólo se cargan cuando hacen falta.
- Apertura automática del mapa después de ubicar direcciones.
- Selector de carga: Cámara, Galería, Archivo o Examinar.
- Campo manual más compacto.
- OCR Intenso por defecto: triple lectura + auditoría; Rápido = doble lectura + conciliación.
- Service Worker `v25`.
