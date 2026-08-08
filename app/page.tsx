"use client";

import Image from "next/image";
import { ChangeEvent, DragEvent, useMemo, useRef, useState } from "react";
import { InstallPwa } from "./pwa-controls";
import { buildRouteTransfer, ROUTE_TRANSFER_KEY } from "@/lib/route-transfer";

type RowState = "verified" | "review";
type ManifestRow = {
  id: string; page: number; rowNumber: number; name: string; address: string;
  locality: string; postalCode: string; barcode: string; confidence: number;
  status: RowState; note?: string;
};
type ScanResult = { manifestNumber: string; pages: number; rows: ManifestRow[]; persisted?: boolean };
type Upload = { id: string; file: File; preview: string };

const places = [
  ["Ascensión", "6003"], ["Junín", "6000"], ["Ferré", "6027"],
  ["Baigorrita", "6013"], ["Los Toldos", "6015"], ["General Viamonte", "6015"],
] as const;

const demo: ScanResult = {
  manifestNumber: "360529110236", pages: 1, persisted: false,
  rows: [
    { id: "d1", page: 1, rowNumber: 1, name: "ANA PÉREZ", address: "SAN MARTÍN 248", locality: "FERRÉ", postalCode: "6027", barcode: "SOPQ2705MLAR00001234EX", confidence: 99, status: "verified" },
    { id: "d2", page: 1, rowNumber: 2, name: "MARCOS GIMÉNEZ", address: "ALMIRANTE BROWN 155", locality: "ASCENSIÓN", postalCode: "6003", barcode: "SOPQ2705MLAR00005678EX", confidence: 97, status: "verified" },
    { id: "d3", page: 1, rowNumber: 3, name: "SOFÍA ROLDÁN", address: "SARMIENTO 71", locality: "JUNÍN", postalCode: "6000", barcode: "F5PQ2605DR00009123", confidence: 84, status: "review", note: "Confirmar la altura en la imagen." },
  ],
};

const stages = ["Alineando la hoja", "Separando filas", "Leyendo campos", "Validando calles", "Comparando lecturas"];
const acceptedImage = /image\/(jpeg|png|webp|heic|heif)/;

function esc(value: string | number) { return `"${String(value).replaceAll('"', '""')}"`; }
function exportCsv(result: ScanResult) {
  const head = ["pagina", "numero", "nombre", "direccion", "localidad", "cp", "barcode", "confianza", "estado"];
  const lines = result.rows.map(row => [row.page, row.rowNumber, row.name, row.address, row.locality, row.postalCode, row.barcode, row.confidence, row.status].map(esc).join(","));
  const url = URL.createObjectURL(new Blob([`\uFEFF${head.join(",")}\n${lines.join("\n")}`], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `manifiesto-${result.manifestNumber || "ocr"}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function Home() {
  const cameraPicker = useRef<HTMLInputElement>(null);
  const galleryPicker = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [mode, setMode] = useState<"maximum" | "fast">("maximum");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ScanResult | null>(null);
  const [filter, setFilter] = useState<"all" | RowState>("all");

  const rows = useMemo(() => !result || filter === "all" ? result?.rows ?? [] : result.rows.filter(row => row.status === filter), [filter, result]);
  const verified = result?.rows.filter(row => row.status === "verified").length ?? 0;
  const review = result?.rows.filter(row => row.status === "review").length ?? 0;

  function addFiles(list: File[]) {
    const supported = list.filter(file => acceptedImage.test(file.type));
    if (!supported.length) {
      setError("Usá imágenes JPG, PNG, WEBP, HEIC o HEIF.");
      return;
    }
    setUploads(current => {
      const valid = supported.slice(0, Math.max(0, 8 - current.length));
      return [...current, ...valid.map(file => ({ id: crypto.randomUUID(), file, preview: URL.createObjectURL(file) }))];
    });
    setResult(null);
    setError("");
  }

  function chosen(event: ChangeEvent<HTMLInputElement>) {
    addFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  }
  function dropped(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    addFiles(Array.from(event.dataTransfer.files));
  }
  function remove(id: string) {
    setUploads(current => current.filter(item => {
      if (item.id === id) URL.revokeObjectURL(item.preview);
      return item.id !== id;
    }));
  }

  async function scan() {
    if (!uploads.length) return;
    setBusy(true);
    setError("");
    setStage(0);
    const ticker = window.setInterval(() => setStage(current => (current + 1) % stages.length), 1800);
    const form = new FormData();
    uploads.forEach(upload => form.append("images", upload.file, upload.file.name));
    form.append("mode", mode);
    try {
      const response = await fetch("/api/scan", { method: "POST", body: form });
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        const body = await response.text();
        const detail = body.trim().startsWith("<") || body.includes("FUNCTION_INVOCATION_TIMEOUT")
          ? "La lectura excedió el tiempo del servidor. Probá el modo rápido."
          : body.trim();
        throw new Error(detail || "Respuesta inválida del servidor.");
      }
      const data = await response.json() as ScanResult & { error?: string };
      if (!response.ok) throw new Error(data.error || "No se pudo procesar el manifiesto.");
      setResult(data);
      setFilter("all");
      window.setTimeout(() => document.querySelector("#results")?.scrollIntoView({ behavior: "smooth" }), 60);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Error inesperado.");
    } finally {
      window.clearInterval(ticker);
      setBusy(false);
    }
  }

  function edit(id: string, field: keyof ManifestRow, value: string) {
    setResult(current => current ? { ...current, rows: current.rows.map(row => row.id === id ? { ...row, [field]: value, status: "verified" as RowState } : row) } : null);
  }
  async function copy() {
    if (result) await navigator.clipboard.writeText(result.rows.map(row => `${row.rowNumber}\t${row.name}\t${row.address}\t${row.locality}\t${row.postalCode}`).join("\n"));
  }

  function sendToRoute() {
    if (!result || review > 0) return;
    localStorage.setItem(ROUTE_TRANSFER_KEY, JSON.stringify(buildRouteTransfer(result)));
    window.location.href = "/ruta?source=ocr";
  }

  return <main>
    <header className="topbar">
      <a className="brand" href="#top" aria-label="Ir al inicio"><span className="brandmark"><i/><i/><i/></span><span>MANIFIESTO <b>OCR</b></span></a>
      <div className="top-actions"><a className="suite-link" href="/ruta">Ruta Postal →</a><span className="online"><i/> Catálogo oficial activo</span><InstallPwa /></div>
    </header>

    <section className="hero" id="top">
      <p className="kicker"><span>01</span> Lectura por filas</p>
      <div className="hero-grid">
        <div>
          <h1>De una foto inclinada a una planilla confiable.</h1>
          <p className="lead">Lee el número de la izquierda, mantiene nombre y domicilio en la misma fila y valida cada calle sin reemplazar silenciosamente el texto original.</p>
          <div className="proof"><span><b>3×</b> controles</span><span><b>6</b> localidades</span><span><b>0</b> errores silenciosos</span></div>
        </div>
        <aside className="row-card">
          <small>BLOQUEO HORIZONTAL</small>
          <div className="row-example"><em>07</em><i/><p><b>VALENTINA ROJAS</b><span>JOSÉ HERNÁNDEZ 236</span><small>6003 · ASCENSIÓN</small></p></div>
          <p>Primero delimita el renglón. Después extrae sus campos.</p>
        </aside>
      </div>
    </section>

    <section className="scanner">
      <div className="heading"><div><p className="kicker"><span>02</span> Cargar manifiesto</p><h2>Escaneá o elegí tus fotos</h2></div><button type="button" className="link" onClick={() => { setResult(demo); setFilter("all"); }}>Ver resultado de ejemplo →</button></div>
      <div className="scan-grid">
        <div className="upload-panel">
          <input ref={cameraPicker} className="hidden" type="file" accept="image/*" capture="environment" aria-label="Tomar una foto con la cámara trasera" onChange={chosen}/>
          <input ref={galleryPicker} className="hidden" type="file" accept="image/*" multiple aria-label="Elegir imágenes de la galería" onChange={chosen}/>
          <div className={`dropzone ${dragging ? "drag" : ""}`} onDragEnter={event => { event.preventDefault(); setDragging(true); }} onDragOver={event => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={dropped}>
            {!uploads.length ? <div className="empty-upload">
              <span className="camera" aria-hidden="true"><i/></span>
              <b>Cargá las páginas del manifiesto</b>
              <span className="empty-copy">Usá la cámara o buscá fotos existentes sin salir de la app.</span>
              <div className="capture-actions">
                <button type="button" className="capture-button camera-button" onClick={() => cameraPicker.current?.click()}><span aria-hidden="true">◉</span><b>Tomar foto</b><small>Cámara trasera</small></button>
                <button type="button" className="capture-button gallery-button" onClick={() => galleryPicker.current?.click()}><span aria-hidden="true">▧</span><b>Elegir de Fotos</b><small>Una o varias</small></button>
              </div>
              <small className="desktop-drop">En computadora también podés arrastrarlas acá</small>
              <small className="photo-tip">Consejo: hoja completa, buena luz y cuatro bordes visibles.</small>
            </div> : <div className="uploads-area">
              <div className="uploads-toolbar"><p><b>{uploads.length} {uploads.length === 1 ? "página" : "páginas"}</b><span>Máximo 8 por lectura</span></p><div><button type="button" onClick={() => cameraPicker.current?.click()}>◉ Cámara</button><button type="button" onClick={() => galleryPicker.current?.click()}>▧ Fotos</button></div></div>
              <div className="uploads">
                {uploads.map((upload, index) => <figure key={upload.id}><Image src={upload.preview} alt={`Vista previa de la página ${index + 1}`} fill sizes="(max-width: 650px) 46vw, 160px" unoptimized/><figcaption>PÁG. {index + 1}</figcaption><button type="button" aria-label={`Quitar página ${index + 1}`} onClick={() => remove(upload.id)}>×</button></figure>)}
                {uploads.length < 8 && <button type="button" className="add" onClick={() => galleryPicker.current?.click()}><b>+</b>Nueva página</button>}
              </div>
            </div>}
          </div>
          <div aria-live="polite">{error && <p className="error"><b>!</b>{error}</p>}</div>
          <div className="mode"><p><b>Modo de lectura</b><span>Velocidad o máxima verificación.</span></p><div><button type="button" className={mode === "fast" ? "active" : ""} onClick={() => setMode("fast")}>Rápido</button><button type="button" className={mode === "maximum" ? "active" : ""} onClick={() => setMode("maximum")}>Precisión máxima</button></div></div>
          <button type="button" className="primary desktop-process" disabled={!uploads.length || busy} onClick={scan} aria-busy={busy}>{busy ? <><i className="spin"/>{stages[stage]}</> : <>Procesar manifiesto <span>→</span></>}</button>
        </div>
        <aside className="method">
          <p className="method-title"><small>MÉTODO ANTI-ERROR</small><b>03 controles antes de aprobar</b></p>
          <ol><li><span>1</span><p><b>Geometría de fila</b><small>Ubica el número y encierra sólo su renglón.</small></p></li><li><span>2</span><p><b>Doble lectura independiente</b><small>Las páginas se comparan en paralelo.</small></p></li><li><span>3</span><p><b>Dirección oficial</b><small>Valida sin modificar la altura leída.</small></p></li></ol>
          <div className="places"><small>LOCALIDADES CONTROLADAS</small><p>{places.map(([name, cp]) => <i key={name}>{name} <b>{cp}</b></i>)}</p></div>
          <p className="privacy">◇ Las fotos no se guardan por defecto. Sólo el resultado confirmado.</p>
        </aside>
      </div>
    </section>

    {uploads.length > 0 && !result && <div className="mobile-actionbar"><p><b>{uploads.length} {uploads.length === 1 ? "página lista" : "páginas listas"}</b><span>{mode === "maximum" ? "Precisión máxima" : "Modo rápido"}</span></p><button type="button" disabled={busy} onClick={scan} aria-busy={busy}>{busy ? <><i className="spin"/>{stages[stage]}</> : <>Procesar <span>→</span></>}</button></div>}

    {result && <section className="results" id="results">
      <div className="results-head"><div><p className="kicker"><span>03</span> Revisar y exportar</p><h2>Manifiesto Nº {result.manifestNumber}</h2><small>{result.pages} pág. · {result.rows.length} filas</small></div><div><button type="button" onClick={copy}>Copiar tabla</button><button type="button" className="dark" onClick={() => exportCsv(result)}>Exportar CSV ↓</button></div></div>
      <div className="summary"><p className="score"><b>{Math.round(verified / Math.max(result.rows.length, 1) * 100)}%</b><span>confirmado</span></p><p><i className="ok">✓</i><b>{verified}</b><span>verificadas</span></p><p><i className="warn">!</i><b>{review}</b><span>para revisar</span></p><nav aria-label="Filtrar filas"><button type="button" className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>Todas</button><button type="button" className={filter === "review" ? "active" : ""} onClick={() => setFilter("review")}>Revisar</button><button type="button" className={filter === "verified" ? "active" : ""} onClick={() => setFilter("verified")}>Verificadas</button></nav></div>
      <div className="table-wrap"><table><thead><tr><th>Nº</th><th>Nombre</th><th>Dirección</th><th>Localidad</th><th>CP</th><th>Confianza</th><th>Estado</th></tr></thead><tbody>{rows.map(row => <tr key={row.id} className={row.status === "review" ? "review" : ""}><td data-label="Fila"><b className="number">{String(row.rowNumber).padStart(2, "0")}</b></td><td data-label="Nombre"><input aria-label={`Nombre de la fila ${row.rowNumber}`} value={row.name} onChange={event => edit(row.id, "name", event.target.value.toUpperCase())}/></td><td data-label="Dirección"><input aria-label={`Dirección de la fila ${row.rowNumber}`} value={row.address} onChange={event => edit(row.id, "address", event.target.value.toUpperCase())}/>{row.note && <small className="note">{row.note}</small>}</td><td data-label="Localidad"><input aria-label={`Localidad de la fila ${row.rowNumber}`} value={row.locality} onChange={event => edit(row.id, "locality", event.target.value.toUpperCase())}/></td><td data-label="CP"><input aria-label={`Código postal de la fila ${row.rowNumber}`} className="cp" inputMode="numeric" value={row.postalCode} onChange={event => edit(row.id, "postalCode", event.target.value.replace(/\D/g, "").slice(0, 4))}/></td><td data-label="Confianza"><span className={`confidence ${row.confidence < 90 ? "low" : ""}`}>{row.confidence}%</span></td><td data-label="Estado"><button type="button" className={`pill ${row.status}`} onClick={() => setResult(current => current ? { ...current, rows: current.rows.map(item => item.id === row.id ? { ...item, status: item.status === "verified" ? "review" : "verified" } : item) } : null)}>{row.status === "verified" ? "✓ Verificada" : "! Revisar"}</button></td></tr>)}</tbody></table></div>
      <div className="results-foot"><span>{review > 0 ? "Revisá toda fila marcada antes de enviarla a la ruta." : "Manifiesto verificado: ya puede pasar al módulo de reparto."}</span><button type="button" className="primary compact" disabled={review > 0} onClick={sendToRoute}>Enviar a Ruta Postal →</button></div>
    </section>}

    <footer><span><i className="brandmark small"><i/><i/><i/></i> MANIFIESTO OCR</span><p>Toda fila dudosa requiere confirmación humana.</p></footer>
  </main>;
}
