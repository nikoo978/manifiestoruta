"use client";

import { useEffect, useState } from "react";

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}



type AppTheme = "light" | "dark";
const THEME_KEY = "ruta-envios-theme";

function preferredTheme(): AppTheme {
  const saved = window.localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: AppTheme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute("content", theme === "dark" ? "#101713" : "#17663d");
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<AppTheme>("light");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const current = preferredTheme();
    setTheme(current);
    applyTheme(current);
    setReady(true);
  }, []);

  function toggle() {
    const next: AppTheme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    window.localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  }

  return <button
    type="button"
    className="theme-toggle icon-action"
    onClick={toggle}
    aria-label={theme === "dark" ? "Usar tema claro" : "Usar tema oscuro"}
    title={theme === "dark" ? "Tema oscuro · cambiar a claro" : "Tema claro · cambiar a oscuro"}
  >
    <span className="theme-icon" aria-hidden="true">{ready && theme === "dark" ? "☾" : "☀"}</span>
  </button>;
}

export function InstallPwa() {
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [isIos, setIsIos] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [ready, setReady] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
    const media = window.matchMedia("(display-mode: standalone)");
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent)
      || (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

    const refreshInstalled = () => setInstalled(media.matches || navigatorWithStandalone.standalone === true);
    setIsIos(ios);
    refreshInstalled();
    setReady(true);

    function beforeInstall(event: Event) {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    }
    function appInstalled() {
      setInstalled(true);
      setInstallPrompt(null);
      setShowHelp(false);
    }
    function displayModeChanged() {
      refreshInstalled();
    }

    window.addEventListener("beforeinstallprompt", beforeInstall);
    window.addEventListener("appinstalled", appInstalled);
    media.addEventListener?.("change", displayModeChanged);
    return () => {
      window.removeEventListener("beforeinstallprompt", beforeInstall);
      window.removeEventListener("appinstalled", appInstalled);
      media.removeEventListener?.("change", displayModeChanged);
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

  if (!ready || installed || (!isIos && !installPrompt)) return null;

  return <>
    <button type="button" className="install-button" onClick={() => void install()}><span aria-hidden="true">↓</span> Instalar app</button>
    {showHelp && <div className="install-backdrop" role="presentation" onClick={() => setShowHelp(false)}>
      <section className="install-sheet" role="dialog" aria-modal="true" aria-labelledby="install-title" onClick={event => event.stopPropagation()}>
        <span className="sheet-handle" aria-hidden="true"/>
        <button type="button" className="sheet-close" aria-label="Cerrar instrucciones" onClick={() => setShowHelp(false)}>×</button>
        <div className="app-icon-mini" aria-hidden="true"><i/><i/><i/></div>
        <p className="kicker"><span>IOS / IPADOS</span> Instalar en iPhone o iPad</p>
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
