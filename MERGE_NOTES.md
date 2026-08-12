# Notas de unificación — v1.3.0

## Base elegida

Se tomó `manifiesto-ocr` v1.2.0 como base porque concentra el flujo OCR, PWA, revisión y persistencia opcional en Supabase.

## Funcionalidades incorporadas de Ruta Postal

- Catálogo de 933 registros de calles.
- Zonas soportadas: Ascensión, Junín, Ferré, Baigorrita, Los Toldos y General Viamonte.
- Corrección/fuzzy matching de calles.
- Geocodificación con Georef Argentina.
- Fallback Photon/OpenStreetMap.
- Estimación mediante calles paralelas con Overpass.
- Mapa y orden de paradas por cercanía.
- Carga manual de direcciones.
- Importación directa de manifiestos PDF.
- Exportación CSV de la ruta.
- Persistencia local del recorrido.

## Integración nueva OCR → Ruta

`lib/route-transfer.ts` define el contrato entre ambos módulos.

Cuando todas las filas OCR están verificadas, el botón **Enviar a Ruta Postal** crea una transferencia local que contiene:

- número de manifiesto;
- página y número de fila;
- número de paquete;
- código/barcode del envío;
- destinatario;
- domicilio;
- localidad y CP;
- zona de Ruta Postal inferida.

Ruta Postal consume esa transferencia una sola vez, conserva el origen y evita reinsertar la misma fila estable del mismo manifiesto.

## Corrección adicional

La persistencia original de Ruta Postal podía escribir un arreglo vacío en `localStorage` durante la hidratación inicial. La v1.3.0 separa lectura y escritura mediante un estado `hydrated` y migra automáticamente `ruta-postal:v1` a `ruta-postal:v2`.

## Dependencias de cliente

Para mantener el `package-lock.json` del proyecto OCR sin introducir paquetes no verificables dentro del entorno de ensamblado, Leaflet y PDF.js se cargan desde jsDelivr sólo cuando se usan `/ruta` y la importación PDF. La aplicación ya requiere conectividad para OCR/geocodificación. Si se desea una instalación totalmente autocontenida, el siguiente refactor puede volver a empaquetarlos como dependencias npm o vendor estático.

## Verificación realizada

- 20 archivos TS/TSX analizados con el compilador TypeScript: sin errores de sintaxis.
- `package.json`, `package-lock.json` y `data/street-catalog.json`: JSON válido.
- 933 registros de calles presentes.
- Imports locales revisados.

No se ejecutó `next build` en el entorno de ensamblado porque su registro npm interno no contiene una dependencia transitiva ya presente en el proyecto OCR original (`zod-validation-error`). Esto es una limitación del registro del entorno, no un error detectado en el código fuente.


## v2.5.2
- Se anula la corrección territorial errónea de v2.5.1: Teodelina vuelve a Santa Fe / General López.
- Tema oscuro persistente con sol/luna.
- Corredor ampliado: Junín, Agustina, Fortín Tiburcio, Ascensión, Ferré, General Arenales y Arribeños, más Teodelina (Santa Fe / General López).
- Geocodificación multi-provincia.
- Callejero Georef enriquecido con rangos de altura y metadatos útiles para OCR/mapa.

### Validaciones adicionales v2.5.2
- El parser PDF respeta la provincia configurada por localidad y los CP alternativos definidos.
- La validación Georef de OCR usa provincia, partido/departamento y localidad, con fallback entre localidad censal y localidad.
- `ACTUALIZAR_CALLEJERO.cmd` permite regenerar el snapshot oficial antes del commit.
- El snapshot incluido en este ensamblado conserva la base heredada hasta ejecutar el actualizador, porque el entorno de ensamblado no tuvo acceso de red directo al archivo de Georef.


## v2.5.3
- Performance Android: mapa persistente, persistencia idle, optimización de ruta memoizada por geometría y postprocesado OCR cooperativo.
- UX: indicador global de trabajo para diferenciar procesos largos de una interfaz tildada.
- CSS móvil reduce efectos GPU costosos y evita pintar tarjetas fuera del viewport.
- Service Worker v24.


## v2.5.4

- Mapa bajo demanda y plegable para reducir consumo en Android.
- Selector único de fuente (cámara, galería, archivo, examinar).
- OCR Intenso por defecto con triple lectura + auditoría.
- Rápido hereda el antiguo Intenso (doble lectura + conciliación).
- Service Worker v25.
