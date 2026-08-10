import Link from "next/link";

export default function OfflinePage() {
  return <main className="offline-page">
    <section>
      <span aria-hidden="true">↯</span>
      <p className="offline-kicker">Ruta Envíos</p>
      <h1>Estás sin conexión</h1>
      <p>La ruta guardada sigue disponible en este dispositivo. Algunas funciones que consultan servidores, como geocodificar u OCR, necesitan internet.</p>
      <div>
        <Link href="/">Abrir mi ruta</Link>
        <Link href="/ocr">Abrir OCR</Link>
      </div>
    </section>
  </main>;
}
