"use client";

import { useEffect, useState } from "react";

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export function InstallPwa() {
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [isIos, setIsIos] = useState(false);
  const [installed, setInstalled] = useState(true);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
    const standalone = window.matchMedia("(display-mode: standalone)").matches || navigatorWithStandalone.standalone === true;
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const platformTimer = window.setTimeout(() => {
      setIsIos(ios);
      setInstalled(standalone);
    }, 0);

    function beforeInstall(event: Event) {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    }
    function appInstalled() {
      setInstalled(true);
      setInstallPrompt(null);
      setShowHelp(false);
    }
    window.addEventListener("beforeinstallprompt", beforeInstall);
    window.addEventListener("appinstalled", appInstalled);
    return () => {
      window.clearTimeout(platformTimer);
      window.removeEventListener("beforeinstallprompt", beforeInstall);
      window.removeEventListener("appinstalled", appInstalled);
    };
  }, []);

  async function install() {
    if (installPrompt) {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === "accepted") setInstalled(true);
      setInstallPrompt(null);
      return;
    }
    setShowHelp(true);
  }

  if (installed || (!isIos && !installPrompt)) return null;

  return <>
    <button type="button" className="install-button" onClick={install}><span aria-hidden="true">↓</span> Instalar app</button>
    {showHelp && <div className="install-backdrop" role="presentation" onClick={() => setShowHelp(false)}>
      <section className="install-sheet" role="dialog" aria-modal="true" aria-labelledby="install-title" onClick={event => event.stopPropagation()}>
        <span className="sheet-handle" aria-hidden="true"/>
        <button type="button" className="sheet-close" aria-label="Cerrar instrucciones" onClick={() => setShowHelp(false)}>×</button>
        <div className="app-icon-mini" aria-hidden="true"><i/><i/><i/></div>
        <p className="kicker"><span>IOS</span> Instalar en iPhone</p>
        <h2 id="install-title">Usala como una app</h2>
        <ol>
          <li><b>1</b><p>Tocá <strong>Compartir</strong><span>El cuadrado con una flecha hacia arriba en Safari.</span></p></li>
          <li><b>2</b><p>Elegí <strong>Agregar a Inicio</strong><span>Puede aparecer como “Añadir a pantalla de inicio”.</span></p></li>
          <li><b>3</b><p>Confirmá con <strong>Agregar</strong><span>Se abrirá a pantalla completa, como cualquier app.</span></p></li>
        </ol>
        <button type="button" className="sheet-done" onClick={() => setShowHelp(false)}>Entendido</button>
      </section>
    </div>}
  </>;
}
