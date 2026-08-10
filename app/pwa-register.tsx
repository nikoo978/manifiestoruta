"use client";

import { useEffect, useRef, useState } from "react";
import { APP_VERSION, CURRENT_RELEASE, SERVICE_WORKER_VERSION, type ReleaseInfo } from "@/lib/app-version";

const VERSION_KEY = "ruta-envios:app-version";
const RELEASE_KEY = "ruta-envios:release-after-update";

function validRelease(value: unknown): value is ReleaseInfo {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ReleaseInfo>;
  return Boolean(item.version && item.serviceWorker && Array.isArray(item.previousFeatures) && Array.isArray(item.changes));
}

export function PwaRegister() {
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const [update, setUpdate] = useState<ReleaseInfo | null>(null);
  const [applying, setApplying] = useState(false);
  const [release, setRelease] = useState<ReleaseInfo | null>(null);
  const [online, setOnline] = useState(true);

  useEffect(() => {
    setOnline(navigator.onLine);
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    let active = true;
    let poll = 0;

    try {
      const pending = localStorage.getItem(RELEASE_KEY);
      if (pending) {
        const parsed = JSON.parse(pending) as unknown;
        if (validRelease(parsed)) setRelease(parsed);
        localStorage.removeItem(RELEASE_KEY);
      }
    } catch { /* resumen opcional */ }

    const controllerUrl = navigator.serviceWorker.controller?.scriptURL ?? "";
    const controllerHasCurrentWorker = controllerUrl.includes(encodeURIComponent(SERVICE_WORKER_VERSION)) || controllerUrl.includes(SERVICE_WORKER_VERSION);
    const storedVersion = localStorage.getItem(VERSION_KEY);
    if (!storedVersion && !navigator.serviceWorker.controller) localStorage.setItem(VERSION_KEY, APP_VERSION);
    if (navigator.serviceWorker.controller && (!controllerHasCurrentWorker || (storedVersion && storedVersion !== APP_VERSION))) {
      setUpdate(CURRENT_RELEASE);
    }

    async function fetchRelease() {
      if (!navigator.onLine) return;
      try {
        const response = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) return;
        const info = await response.json() as unknown;
        if (!active || !validRelease(info)) return;
        const installedVersion = localStorage.getItem(VERSION_KEY) || APP_VERSION;
        if (info.version !== installedVersion || info.version !== APP_VERSION) {
          setUpdate(info);
          void registrationRef.current?.update();
        }
      } catch { /* la app sigue funcionando offline */ }
    }

    function watchRegistration(registration: ServiceWorkerRegistration) {
      registrationRef.current = registration;
      if (registration.waiting && navigator.serviceWorker.controller) setUpdate((current) => current ?? CURRENT_RELEASE);
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller && active) {
            setUpdate((current) => current ?? CURRENT_RELEASE);
          }
        });
      });
    }

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void registrationRef.current?.update();
        void fetchRelease();
      }
    };
    const onOnline = () => {
      void registrationRef.current?.update();
      void fetchRelease();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);

    void navigator.serviceWorker.register(`/sw.js?${encodeURIComponent(SERVICE_WORKER_VERSION)}`, { scope: "/", updateViaCache: "none" })
      .then((registration) => {
        if (!active) return;
        watchRegistration(registration);
        void registration.update();
        void fetchRelease();
        // Cinco minutos evita consultas innecesarias sin perder actualizaciones al volver a la app.
        poll = window.setInterval(fetchRelease, 5 * 60_000);
      })
      .catch((error) => console.warn("No se pudo registrar el modo PWA.", error));

    return () => {
      active = false;
      if (poll) window.clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onControllerChange = () => {
      if (!applying) return;
      const target = update ?? CURRENT_RELEASE;
      try {
        localStorage.setItem(VERSION_KEY, target.version);
        localStorage.setItem(RELEASE_KEY, JSON.stringify(target));
      } catch { /* no bloquear actualización por storage */ }
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    return () => navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
  }, [applying, update]);

  async function applyUpdate() {
    if (applying) return;
    setApplying(true);
    const registration = registrationRef.current;
    const target = update ?? CURRENT_RELEASE;
    if (!registration) {
      try {
        localStorage.setItem(VERSION_KEY, target.version);
        localStorage.setItem(RELEASE_KEY, JSON.stringify(target));
      } catch { /* noop */ }
      window.location.reload();
      return;
    }

    try {
      await registration.update();
      let worker = registration.waiting;
      if (!worker && registration.installing) {
        worker = await new Promise<ServiceWorker | null>((resolve) => {
          const installing = registration.installing!;
          const done = () => {
            if (installing.state === "installed") resolve(registration.waiting ?? installing);
            else if (installing.state === "redundant") resolve(null);
          };
          installing.addEventListener("statechange", done);
          done();
        });
      }
      try {
        localStorage.setItem(VERSION_KEY, target.version);
        localStorage.setItem(RELEASE_KEY, JSON.stringify(target));
      } catch { /* noop */ }
      if (worker) worker.postMessage({ type: "SKIP_WAITING" });
      else window.location.reload();
    } catch {
      setApplying(false);
    }
  }

  return <>
    {!online && <div className="pwa-network-banner" role="status">Sin conexión · la ruta guardada sigue disponible</div>}

    {update && <div className="pwa-update-banner" role="status">
      <span>Se detectó una nueva actualización</span>
      <button type="button" onClick={() => void applyUpdate()} disabled={applying || !online}>{applying ? "Actualizando…" : online ? "Actualizar versión…" : "Esperando conexión"}</button>
    </div>}

    {release && <div className="pwa-release-backdrop" role="presentation" onClick={() => setRelease(null)}>
      <section className="pwa-release-sheet" role="dialog" aria-modal="true" aria-labelledby="pwa-release-title" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="pwa-release-close" aria-label="Cerrar" onClick={() => setRelease(null)}>×</button>
        <small>Ruta Envíos · v{release.version}</small>
        <h2 id="pwa-release-title">{release.title}</h2>
        <h3>Se mantienen</h3>
        <ul>{release.previousFeatures.map((item) => <li key={item}>{item}</li>)}</ul>
        <h3>Novedades</h3>
        <ul>{release.changes.map((item) => <li key={item}>{item}</li>)}</ul>
        <button type="button" className="pwa-release-done" onClick={() => setRelease(null)}>Entendido</button>
      </section>
    </div>}
  </>;
}
