# Suite Manifiestos

Versión unificada de **Manifiesto OCR** y **Ruta Postal**.

## Flujo principal

1. Fotografiar o cargar hasta 8 páginas del manifiesto en `/`.
2. Extraer filas con OCR y validar nombre, domicilio, localidad y código postal.
3. Revisar manualmente cualquier fila marcada.
4. Pulsar **Enviar a Ruta Postal**.
5. La ruta recibe las filas verificadas, corrige el nombre de calle con el catálogo oficial, geocodifica y ordena las paradas por cercanía.
6. También se mantiene la importación directa de manifiestos PDF desde `/ruta`.

La transferencia OCR → Ruta se realiza localmente en el navegador. Las filas incorporadas guardan el número de manifiesto y un identificador de origen para evitar duplicados al reenviar el mismo manifiesto.

## Módulos

- `/` — Manifiesto OCR: cámara/galería, doble lectura, adjudicación de discrepancias, revisión y CSV.
- `/ruta` — Ruta Postal: importación OCR/PDF, carga manual, callejero, geocodificación, mapa, optimización y CSV.
- `/api/scan` — OCR con Gemini / Vercel AI Gateway.
- `/api/geocode` — Georef Argentina + Photon/OpenStreetMap + Overpass.
- `/api/calles` — Exportación del catálogo de calles.

## Variables de Vercel

```env
GOOGLE_GENERATIVE_AI_API_KEY=
SUPABASE_URL=
SUPABASE_SECRET_KEY=
```

Supabase sigue siendo opcional. La ruta postal no requiere claves de mapas pagas.

## Desarrollo

```bash
npm install
npm run lint
npm run build
npm run dev
```

## Datos locales

La ruta se persiste en `localStorage` con la clave `ruta-postal:v2`. La versión unificada migra automáticamente los datos existentes de `ruta-postal:v1` cuando están disponibles.
"# manifiestoruta" 
"# suite-manifiestos" 
