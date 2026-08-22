# Ruta Envíos

Versión 2.6.0. Ruta Envíos unifica carga, OCR, geocodificación, Google Maps y preparación del reparto en una sola PWA responsive.

## Carga

- Direcciones libres, una por línea. Ej.: `Rivadavia 40 Junín`.
- Cruces y entrecalles. Ej.: `Arias entre Cabrera y Quintana Junín`.
- PDF con lectura de texto, sin OCR.
- Imágenes con OCR automático.
- Arrastrar y soltar PDF o imágenes.

## Google Maps

La aplicación intenta ubicar cada parada con Georef Argentina, Photon/OpenStreetMap y los fallbacks de calles/intersecciones gratuitos. La visualización usa Google Maps vectorial, marcadores avanzados numerados y, cuando `Routes API` está habilitada, dibuja el recorrido real por calles con distancia y tiempo estimados. Los manifiestos largos se dividen en tramos de hasta 10 paradas intermedias para mantener las solicitudes en la categoría Essentials.

El mapa se carga únicamente al desplegarlo. Todas las localidades pueden optimizarse en una sola ruta; los chips funcionan como filtros visuales. Cada parada tiene un botón **Ir** que abre Google Maps para navegar. Si una dirección queda pendiente, puede buscarse en Google Maps y corregirse pegando coordenadas (`lat, lon` o una URL que las contenga).

### Configuración segura y de bajo costo

1. En Google Cloud, creá o elegí un proyecto con facturación habilitada.
2. Habilitá **Maps JavaScript API** y, para el trazado vial, **Routes API**.
3. Creá una clave de API con restricción de aplicación **Sitios web**.
4. Permití `https://manifiesto-ocr.vercel.app/*` y `http://localhost:3000/*`. Agregá dominios de Preview sólo si realmente los usás.
5. Restringí la clave exclusivamente a **Maps JavaScript API** y **Routes API**.
6. En Vercel agregá `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` en Production, Preview y Development.
7. Opcional: creá un Map ID de tipo JavaScript y configuralo como `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID`.
8. Configurá alertas de presupuesto y una cuota diaria conservadora en Google Cloud.

`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` llega al navegador por diseño. No debe tratarse como un secreto: su protección correcta son las restricciones de dominio y de API. Para desactivar las solicitudes de rutas sin quitar el mapa, usá `NEXT_PUBLIC_GOOGLE_MAPS_ROUTES_ENABLED=false`.

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
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=
NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID=
NEXT_PUBLIC_GOOGLE_MAPS_ROUTES_ENABLED=true
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

## v2.6.0

- Google Maps JavaScript API reemplaza Leaflet/OpenStreetMap como mapa visual.
- Advanced Markers numerados y accesibles, con destinatario, dirección y navegación.
- Routes API opcional para recorrido vial, distancia y tiempo estimado; fallback visual si no está habilitada.
- Carga lazy del mapa para reducir solicitudes y consumo en iPhone.
- Botón **Ir** por parada con apertura de Google Maps.
- Nuevo centro operativo responsive, métricas de jornada y acabado visual profesional.
- Service Worker `v26`.
