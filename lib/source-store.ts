"use client";

export type StoredSource = {
  id: string;
  name: string;
  type: string;
  kind: "image" | "pdf";
  blob: Blob;
  createdAt: number;
};

const DB_NAME = "ruta-envios-sources";
const DB_VERSION = 1;
const STORE = "sources";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("No se pudo abrir el almacenamiento local."));
  });
}

export async function saveSourceFile(file: File, kind: "image" | "pdf") {
  const id = `src:${crypto.randomUUID()}`;
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({
        id,
        name: file.name,
        type: file.type,
        kind,
        blob: file,
        createdAt: Date.now(),
      } satisfies StoredSource);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("No se pudo guardar la fuente."));
      tx.onabort = () => reject(tx.error ?? new Error("No se pudo guardar la fuente."));
    });
    return id;
  } finally {
    db.close();
  }
}

export async function getSourceFile(id: string): Promise<StoredSource | null> {
  const db = await openDb();
  try {
    return await new Promise<StoredSource | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).get(id);
      request.onsuccess = () => resolve((request.result as StoredSource | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error("No se pudo abrir la fuente."));
    });
  } finally {
    db.close();
  }
}

export async function clearSourceFiles() {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("No se pudieron limpiar las fuentes."));
    });
  } finally {
    db.close();
  }
}
