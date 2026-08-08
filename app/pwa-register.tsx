"use client";

import { useEffect } from "react";

const SW_VERSION = "v8";

export function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    let active = true;
    const onControllerChange = () => {
      const key = `ruta-envios-sw-${SW_VERSION}`;
      if (!active || sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    void navigator.serviceWorker.register(`/sw.js?${SW_VERSION}`, { scope: "/", updateViaCache: "none" })
      .then((registration) => registration.update())
      .catch((error) => console.warn("No se pudo registrar el modo PWA.", error));
    return () => {
      active = false;
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);
  return null;
}
