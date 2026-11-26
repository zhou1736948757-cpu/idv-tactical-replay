export const CANVAS_FONT_CJK = '"Noto Serif SC", serif';
export const CANVAS_FONT_LATIN = '"Cinzel", "Cormorant Garamond", "Noto Serif SC", serif';

const family = 'IDV Custom Display';
const store = 'display';
const key = 'active';
let activeFace: FontFace | undefined;
let pending = Promise.resolve();

export async function whenFontsReady(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return;

  // Canvas text does not trigger CSS font selection on its own.
  await Promise.allSettled([
    document.fonts.load('500 14px "Noto Serif SC"', '庄园战术复盘档案 0123456789'),
    document.fonts.load('700 16px "Noto Serif SC"', '庄园战术复盘档案 0123456789'),
    document.fonts.load('600 14px Cinzel', 'IDENTITY V OLETUS MANOR 0123456789'),
    document.fonts.load('600 italic 16px "Cormorant Garamond"', 'Match Archive Tactical Case File 0123456789'),
    document.fonts.load('700 italic 18px "Cormorant Garamond"', 'Stage 04 05 0123456789'),
  ]);
  await document.fonts.ready;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('idv.fonts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function accessFont<T>(
  mode: IDBTransactionMode,
  operation: (fonts: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(store, mode);
      const request = operation(transaction.objectStore(store));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error ?? request.error ?? new Error('Font transaction aborted'));
    });
  } finally {
    database.close();
  }
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation);
  pending = result.then(() => undefined, () => undefined);
  return result;
}

function applyFace(face?: FontFace): void {
  if (face) document.fonts.add(face);
  if (activeFace) document.fonts.delete(activeFace);
  activeFace = face;
}

function prepareFace(buffer: ArrayBuffer): Promise<FontFace> {
  return new FontFace(family, buffer).load();
}

export function registerCustomDisplayFont(buffer: ArrayBuffer): Promise<void> {
  return enqueue(async () => applyFace(await prepareFace(buffer)));
}

export function loadStoredCustomFont(): Promise<boolean> {
  return enqueue(async () => {
    try {
      const buffer: unknown = await accessFont('readonly', (fonts) => fonts.get(key));
      if (!(buffer instanceof ArrayBuffer)) return false;
      applyFace(await prepareFace(buffer));
      return true;
    } catch {
      // A disabled database or an unreadable font leaves the bundled stack active.
      return false;
    }
  });
}

export function saveCustomDisplayFont(buffer: ArrayBuffer): Promise<void> {
  return enqueue(async () => {
    const face = await prepareFace(buffer);
    await accessFont('readwrite', (fonts) => fonts.put(buffer, key));
    applyFace(face);
  });
}

export function clearCustomDisplayFont(): Promise<void> {
  return enqueue(async () => {
    await accessFont('readwrite', (fonts) => fonts.delete(key));
    applyFace();
  });
}
