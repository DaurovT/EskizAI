/**
 * Предварительная раскладка деталей по листам для экрана SCR-11 (полосовая укладка).
 * Точный раскрой делает ядро (core/nesting.py) и отдаёт файлами — это только превью.
 */
import type { ViewerModel } from '@mebel/viewer';
import type { NestingMaterial, NestingOut, NestingSheet } from '../api/types';

export const SHEET = { length: 2800, width: 2070, kerf: 4, trim: 10 };

export interface Placed { number: number; name: string; x: number; y: number; l: number; w: number; rotated: boolean }
export interface Sheet {
  material: string; materialName: string; parts: Placed[]; usedArea: number; waste: number;
  /** Размер листа, мм (нет — стандартный 2800×2070). */
  length?: number; width?: number;
}

const SKIP = /^(rod_|mirror_|countertop_)/;

export function layoutSheets(model: ViewerModel): Sheet[] {
  const byMat = new Map<string, { number: number; name: string; l: number; w: number; grain: boolean }[]>();
  for (const p of model.parts) {
    if (SKIP.test(p.material)) continue;
    const list = byMat.get(p.material) ?? [];
    list.push({ number: p.number, name: p.name, l: p.length, w: p.width, grain: model.materials[p.material]?.hasGrain ?? false });
    byMat.set(p.material, list);
  }
  const L = SHEET.length - 2 * SHEET.trim;
  const W = SHEET.width - 2 * SHEET.trim;
  const sheets: Sheet[] = [];
  for (const [mat, parts] of byMat) {
    // длинной стороной вдоль листа; без текстуры можно поворачивать
    const items = parts
      .map((p) => {
        const rot = !p.grain && p.w > p.l;
        return { ...p, L: rot ? p.w : p.l, W: rot ? p.l : p.w, rotated: rot };
      })
      .filter((p) => p.L <= L && p.W <= W)
      .sort((a, b) => b.W - a.W || b.L - a.L);
    let cur: { placed: Placed[]; shelves: { y: number; h: number; x: number }[] } | null = null;
    const flush = () => {
      if (!cur) return;
      const used = cur.placed.reduce((s, p) => s + p.l * p.w, 0);
      sheets.push({
        material: mat,
        materialName: model.materials[mat]?.name ?? mat,
        parts: cur.placed,
        usedArea: used,
        waste: Math.max(0, 1 - used / (SHEET.length * SHEET.width)),
      });
    };
    for (const it of items) {
      let placed = false;
      for (let attempt = 0; attempt < 2 && !placed; attempt++) {
        if (!cur) cur = { placed: [], shelves: [] };
        for (const sh of cur.shelves) {
          if (it.W <= sh.h && sh.x + it.L <= L) {
            cur.placed.push({ number: it.number, name: it.name, x: SHEET.trim + sh.x, y: SHEET.trim + sh.y, l: it.L, w: it.W, rotated: it.rotated });
            sh.x += it.L + SHEET.kerf;
            placed = true;
            break;
          }
        }
        if (!placed) {
          const top = cur.shelves.reduce((s, sh) => Math.max(s, sh.y + sh.h + SHEET.kerf), 0);
          if (top + it.W <= W) {
            cur.shelves.push({ y: top, h: it.W, x: it.L + SHEET.kerf });
            cur.placed.push({ number: it.number, name: it.name, x: SHEET.trim, y: SHEET.trim + top, l: it.L, w: it.W, rotated: it.rotated });
            placed = true;
          } else {
            flush();
            cur = null;
          }
        }
      }
    }
    flush();
  }
  return sheets;
}

/**
 * Лист точного раскроя ядра (GET /projects/{id}/nesting) → формат схемы SheetLayout.
 * У ядра y — от нижнего края листа, на экране — от верхнего.
 */
export function sheetFromNesting(m: NestingMaterial, s: NestingSheet): Sheet {
  return {
    material: m.material,
    materialName: m.material_name,
    length: s.length,
    width: s.width,
    usedArea: Math.round(s.usage * s.length * s.width),
    waste: Math.max(0, 1 - s.usage),
    parts: s.parts.map((p) => ({ number: p.number, name: p.name, x: p.x, y: s.width - p.y - p.width, l: p.length, w: p.width, rotated: p.rotated })),
  };
}

export const nestingSheets = (n: NestingOut): Sheet[] => n.materials.flatMap((m) => m.sheets.map((s) => sheetFromNesting(m, s)));

/** Обратное: превью раскладки в формате API (для мока). */
export function nestingFromViewer(model: ViewerModel, versionId = 'local', versionNumber = 1): NestingOut {
  const byMat = new Map<string, Sheet[]>();
  for (const s of layoutSheets(model)) byMat.set(s.material, [...(byMat.get(s.material) ?? []), s]);
  const materials: NestingMaterial[] = [...byMat.entries()].map(([mat, sheets]) => {
    const used = sheets.reduce((a, s) => a + s.usedArea, 0);
    return {
      material: mat, material_name: sheets[0].materialName, has_grain: model.materials[mat]?.hasGrain ?? false,
      sheets_count: sheets.length, waste_percent: Math.round(1000 * (1 - used / (sheets.length * SHEET.length * SHEET.width))) / 10,
      parts_area_m2: Math.round(used / 1e3) / 1e3,
      sheets: sheets.map((s, i) => ({
        index: i + 1, length: SHEET.length, width: SHEET.width, usage: Math.round(1000 * (1 - s.waste)) / 1000,
        parts: s.parts.map((p) => ({ number: p.number, name: p.name, x: p.x, y: SHEET.width - p.y - p.w, length: p.l, width: p.w, rotated: p.rotated })),
      })),
    };
  });
  return { version_id: versionId, version_number: versionNumber, trim: SHEET.trim, kerf: SHEET.kerf, materials,
    sheets_total: materials.reduce((a, m) => a + m.sheets_count, 0), unplaced: [] };
}

/** CSV деталей (как пакет мастера): номер; название; материал; длина; ширина; толщина. */
export function partsCsv(model: ViewerModel): string {
  const rows = [['№', 'Деталь', 'Материал', 'Длина', 'Ширина', 'Толщина'].join(';')];
  for (const p of model.parts) {
    rows.push([p.number, p.name, model.materials[p.material]?.name ?? p.material, p.length.toFixed(1), p.width.toFixed(1), p.thickness].join(';'));
  }
  return rows.join('\n');
}

export function parseCsv(text: string): string[][] {
  return text.split(/\r?\n/).filter(Boolean).map((l) => l.split(/[;,]/));
}
