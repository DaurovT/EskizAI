import {
  AdditiveBlending,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Camera,
  Color,
  DoubleSide,
  EdgesGeometry,
  Group,
  Light,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  PointLight,
  Quaternion,
  Raycaster,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  Vector2,
  Vector3,
  type Intersection,
  type Scene,
  type WebGLRenderer,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { axisToThree, coreAxisVector, coreToThree, partToSceneMatrix, unitScale, type SceneUnits } from './axes.js';
import { fitCamera, type CameraFit } from './camera.js';
import { buildDimensions, computeDimensions, type DimensionInfo, type DimensionOptions, type DimensionsHandle } from './dimensions.js';
import { localPartGeometry, placeLocalGeometry } from './geometry.js';
import { addDecorAttributes, hasDecor, inlayName, kelvinColor, localDecorGeometry, paintRoughness } from './decor.js';
import { createStudioEnvironment } from './envmap.js';
import { createGlowTexture, ledFrame, ledProfileGeometry, quadsGeometry, type Quad } from './lights.js';
import { DEFAULT_FINISHES, hardwareGeometry } from './hardware.js';
import {
  PBR_PRESETS,
  createMaterial,
  GRAIN_TILE_MM,
  createWoodGrainTexture,
  loadTextureAsync,
  loadTextureUrl,
  materialType,
  patchDecorMaterial,
  type InlayUniforms,
  type MaterialConfig,
  type MaterialType,
  type ProductMaterial,
} from './materials.js';
import { contactShadowGeometry } from './ao.js';
import { qualitySettings, type QualityLevel, type QualitySettings } from './quality.js';
import { sceneStats, type SceneStats } from './stats.js';
import type {
  CoreVec3,
  HardwareFinish,
  PickResult,
  ViewerHardware,
  ViewerLight,
  ViewerModel,
  ViewerNode,
  ViewerPart,
} from './types.js';

export interface ProductSceneOptions {
  /** Единицы сцены. По умолчанию метры — тот же масштаб, что в AR. */
  units?: SceneUnits;
  /**
   * Пресет качества: рёбра, материалы, текстуры, слияние мешей, сегменты дуг.
   * По умолчанию 'high'. Явные опции ниже (edges, curveSegments, merge, textures) важнее пресета.
   */
  quality?: QualityLevel;
  /** Тонкие тёмные линии по рёбрам деталей. По умолчанию — по пресету (high/medium — да). */
  edges?: boolean;
  edgeColor?: string;
  edgeOpacity?: number;
  /** Шероховатость матовых материалов (0..1). */
  roughness?: number;
  /** Сегментов на дугу контура. */
  curveSegments?: number;
  /** Время полного хода двери/ящика, с. */
  nodeDuration?: number;
  /** Время «взрыва», с. */
  explodeDuration?: number;
  /** Насколько разлетаются детали при «взрыве» (доля расстояния от центра). */
  explodeFactor?: number;
  /** Слить неподвижные детали одного материала в один меш (меньше draw calls). По умолчанию — по пресету. */
  merge?: boolean;
  /** Текстуры декоров. По умолчанию — по пресету (да). */
  textures?: boolean;
  /** Настройки материалов по id: тип поверхности, картинка декора, масштаб плитки. */
  materials?: Record<string, MaterialConfig>;
  /** Загрузчик картинок декора (в RN можно подставить свой). По умолчанию THREE.TextureLoader. */
  textureLoader?: (url: string) => Texture | null;
  /**
   * Загрузка сканов декора из модели (`materials[id].texture`, масштаб — `textureSizeMm`). Пока скан грузится
   * (или если не загрузился) — процедурные волокна у `hasGrain`. По умолчанию в браузере — TextureLoader,
   * в Node и RN — нет (передайте свой, например через expo-asset). null — не грузить.
   */
  loadTexture?: ((url: string) => Promise<Texture | null>) | null;
  /** Тени у стыков (AO-полосы, один вызов отрисовки). По умолчанию — по пресету (да). */
  ao?: boolean;
  /** Цвет подсветки выбранной детали. */
  highlightColor?: string;
  /** Показать размеры сразу (или настройки размеров). */
  dimensions?: boolean | DimensionOptions;
  /**
   * Фурнитура (ручки, петли, штангодержатели, ножки, направляющие…): true/'all' — вся, 'visible' — без петель
   * и направляющих, false/'none' — без неё. По умолчанию — по пресету качества (low — 'visible').
   */
  hardware?: boolean | 'all' | 'visible' | 'none';
  /**
   * Своя «студия» для отражений металла и глянца, пока снаружи не задана карта окружения (setEnvironment).
   * По умолчанию да (кроме quality low): без неё металл без карты окружения — «полуметалл».
   */
  studioEnvironment?: boolean;
  /**
   * Комната (model.room: стены, пол, потолок) — светлые полупрозрачные плоскости для контекста встроенной мебели.
   * По умолчанию показана, если есть в модели. false — не строить (GLB, превью).
   */
  room?: boolean;
}

export interface LightsOnOptions {
  /** Во сколько раз приглушить свет сцены (не свой). По умолчанию 0.4 — «вечер». 1 — не трогать. */
  dim?: number;
}

export interface PartHandle {
  part: ViewerPart;
  mesh: Mesh;
  edges: LineSegments | null;
  /** Центр детали в закрытом состоянии, координаты сцены. */
  center: Vector3;
  /** Смещение при полном «взрыве», координаты сцены. */
  explodeOffset: Vector3;
  /**
   * Деталь входит в общий меш материала (quality low/medium; у узла — свой общий меш внутри узла). Её свой меш скрыт,
   * но остаётся для выбора лучом, габаритов, подсветки и «взрыва».
   */
  merged?: boolean;
  /**
   * Ключ материала: id материала ядра, `paint:<цвет>:<блеск>` (покраска) или `vc:<id>` (декор без покраски).
   * У деталей с декором пазы и накладки входят в тот же меш (цвет вершин).
   */
  materialKey: string;
}

/**
 * Металлическая вставка / кант фасада. Своего меша нет: металл лежит в меше фасада
 * (треугольники [triStart, triEnd) с metalMask = 1) — фасад с рамкой рисуется одним вызовом.
 */
export interface DecorHandle {
  part: PartHandle;
  kind: 'inlay';
  finish: string;
  name: string;
  triStart: number;
  triEnd: number;
}

/** LED-подсветка в сцене. */
export interface LightHandle {
  light: ViewerLight;
  /** Профиль с рассеивателем. */
  mesh: Mesh;
  /** Пятна света (на поверхности под ним, на задней стенке) и ореол — видны, когда свет включён. */
  glow: Mesh | null;
  point: PointLight | null;
  /** Деталь, к которой крепится профиль. */
  parent: PartHandle | null;
  explodeOffset: Vector3;
  color: Color;
}

/** Фурнитура в сцене: один меш на элемент (все формы слиты). */
export interface HardwareHandle {
  item: ViewerHardware;
  mesh: Mesh;
  /** Деталь-«родитель»: с ней фурнитура разлетается при «взрыве» и подсвечивается. */
  parent: PartHandle | null;
  /** Смещение при полном «взрыве» — как у детали-«родителя». */
  explodeOffset: Vector3;
  /** Входит в общий меш (quality low/medium). */
  merged?: boolean;
}

export interface NodeHandle {
  node: ViewerNode;
  /** Группа узла: стоит в точке узла, вращается или едет. */
  pivot: Group;
  /** Точка узла в сцене. */
  origin: Vector3;
  /** Ось/направление в сцене (единичный вектор). */
  axis: Vector3;
  parts: PartHandle[];
  /** Фурнитура узла (ручки, чашки петель, шины направляющих). */
  hardware: HardwareHandle[];
  /** Подсветка, которая едет с узлом. */
  lights: LightHandle[];
  /** Текущая открытость 0..1 (линейный прогресс). */
  progress: number;
  /** Цель анимации 0 или 1. */
  target: number;
}

/**
 * Что подсветить: номер детали, ключ детали, префикс ключа (узел или секция,
 * например "sections[1]" или "base[2]"), id узла — или список таких значений.
 */
export type HighlightTarget = number | string | ReadonlyArray<number | string>;

export interface HighlightOptions {
  /** Остальные детали полупрозрачные («рентген») — видно полку за закрытой дверью. */
  ghost?: boolean;
  color?: string;
}

/** Мягкое ускорение и торможение. */
export function easeInOut(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

const PART_TAG = '__mebelPart';
const HW_TAG = '__mebelHardware';
/** Сколько PointLight максимум (каждая — цикл в шейдере всех материалов). */
const MAX_POINT_LIGHTS = 4;
/** Рассеиватель выключенной подсветки — молочно-серый. */
const LED_OFF = new Color('#d9d7d2');
/** Металличность металла (фурнитура, штанга) без карты окружения — иначе он чёрный (приложение карту не ставит). */
const METAL_NO_ENV = 0.35;

/**
 * Контракт userData мешей сцены (для выбора касанием и своих обработчиков):
 * - деталь: `kind: 'part'`, `partNumber`, `partKey`, `nodeId` (узел или null);
 * - фурнитура: `kind: 'hardware'`, `hardwareId`, `hardwareKind` (handle, hinge, rod_holder, slide, leg,
 *   profile, rail, carousel, swing_shelf), `hardwareName` (как в смете), `partKey` — ключ детали-«родителя»
 *   (дверь с ручкой, штанга со штангодержателем…), `nodeId`;
 * - общие меши слияния: `isMerged: true` (луч их не видит), рёбра: `isEdges: true`.
 * `pick()` / `pickAt()` при попадании в фурнитуру возвращают деталь-«родителя» с `kind: 'hardware'`
 * и `hardware: { id, kind, name }` — так тап по ручке открывает дверь.
 * «Взрыв»: фурнитура разлетается вместе со своей деталью-«родителем».
 */

/** Тип поверхности по id материала из каталога ядра. */
export type SurfaceKind = 'board' | 'metal' | 'mirror' | 'glass';

export function surfaceKind(materialId: string): SurfaceKind {
  const id = materialId.toLowerCase();
  if (id.includes('mirror')) return 'mirror';
  if (id.includes('glass')) return 'glass';
  if (id.includes('chrome') || id.includes('metal') || id.startsWith('rod_') || id.includes('alu')) return 'metal';
  return 'board';
}

/** Совпадает ли деталь с целью подсветки. */
export function matchesTarget(part: ViewerPart, target: HighlightTarget): boolean {
  const list: ReadonlyArray<number | string> = Array.isArray(target) ? target : [target as number | string];
  for (const t of list) {
    if (typeof t === 'number') {
      if (part.number === t) return true;
      continue;
    }
    if (!t) continue;
    const k = part.key;
    if (k === t || k.startsWith(`${t}.`) || k.startsWith(`${t}[`)) return true;
    const n = part.node;
    if (n && (n === t || n.startsWith(`${t}.`) || n.startsWith(`${t}[`))) return true;
  }
  return false;
}

const tmpQ = new Quaternion();
const tmpV = new Vector3();
const noRaycast = () => {};

/**
 * Сцена изделия без React и без DOM: можно использовать в вебе
 * и в React Native (expo-gl / @react-three/fiber/native).
 *
 * Корневая группа `root` — в координатах three.js (Y вверх), начало — левый
 * нижний передний угол изделия, фасад смотрит в +z.
 */
/**
 * Общие на все сцены исходники текстур (волокна, «студия»): сцена берёт клоны — у них общий source, и three не грузит
 * картинку в GPU заново после каждой правки (новая сцена — те же текстуры). Исходники не освобождаются: они маленькие.
 */
const sharedGrain = new Map<number, Texture>();
let sharedStudio: Texture | null = null;

export class ProductScene {
  readonly model: ViewerModel;
  readonly root: Group;
  readonly units: SceneUnits;
  readonly scale: number;
  readonly parts: PartHandle[] = [];
  readonly nodes = new Map<string, NodeHandle>();
  /** Габарит в закрытом состоянии (единицы сцены). */
  readonly closedBounds = new Box3();
  readonly quality: QualityLevel;
  /** Итоговые настройки: пресет качества + явные опции. */
  readonly settings: QualitySettings;
  /** Общие меши неподвижных деталей (по одному на материал), если включено слияние. */
  readonly mergedMeshes: Mesh[] = [];
  /** Фурнитура (пусто, если в модели её нет или она выключена). */
  readonly hardware: HardwareHandle[] = [];
  /** Общие меши фурнитуры (по отделке), если включено слияние. Сюда же сливаются металлические вставки фасадов. */
  readonly mergedHardware: Mesh[] = [];
  /** Металлические вставки и канты фасадов (всё — внутри меша фасада). */
  readonly decor: DecorHandle[] = [];
  /** LED-подсветка. */
  readonly lights: LightHandle[] = [];
  /** Комната (стены, пол, потолок) одним мешем; null — нет в модели или выключена. */
  readonly room: Mesh | null = null;
  /** Тени у стыков (AO) одним мешем; null — выключены или стыков нет. */
  readonly ao: Mesh | null = null;
  /** Сцена изменилась сама (догрузился скан декора) — перерисовать кадр (frameloop="demand"). */
  onChange: (() => void) | null = null;

  private readonly materials = new Map<string, ProductMaterial>();
  private readonly highlightMaterials = new Map<string, ProductMaterial>();
  private ghostMaterial: MeshLambertMaterial | null = null;
  private readonly ownedTextures: Texture[] = [];
  private grainTexture: Texture | null = null;
  /** Волокна с повтором под шаг UV материала (ключ — шаг). */
  private readonly grainByUnit = new Map<string, Texture>();
  /** Загруженные сканы декоров по id материала. */
  private readonly scans = new Map<string, Texture>();
  private readonly scanRequests = new Set<string>();
  private readonly loadTexture: ((url: string) => Promise<Texture | null>) | null;
  private disposed = false;
  private readonly edgeMaterial: LineBasicMaterial | null;
  private readonly opts: Required<
    Omit<
      ProductSceneOptions,
      | 'units'
      | 'quality'
      | 'materials'
      | 'textureLoader'
      | 'dimensions'
      | 'roughness'
      | 'hardware'
      | 'studioEnvironment'
      | 'room'
      | 'loadTexture'
      | 'ao'
    >
  > & { roughness: number | undefined };
  private explodeProgress = 0;
  private explodeTarget = 0;
  private envMap: Texture | null = null;
  private highlightSet = new Set<PartHandle>();
  private hwHighlightSet = new Set<HardwareHandle>();
  private ghost = false;
  private highlightColor: Color;
  private dims: DimensionsHandle | null = null;
  private readonly dimOptions: DimensionOptions;
  private readonly materialConfig: Record<string, MaterialConfig>;
  private readonly textureLoader: (url: string) => Texture | null;
  private readonly finishes: Record<string, HardwareFinish>;
  /** Тип поверхности для ключей покраски (`paint:…`). */
  private readonly customTypes = new Map<string, MaterialType>();
  private studioEnv: Texture | null = null;
  private readonly useStudio: boolean;
  private glowTexture: Texture | null = null;
  private readonly ledMaterials = new Map<string, MeshBasicMaterial>();
  private lightsOnState = false;
  /** Приглушённый свет сцены (не свой): исходная яркость. */
  private readonly dimmed = new Map<Light, number>();
  private bgBase: Color | null = null;
  private bgTarget: Color | null = null;

  constructor(model: ViewerModel, options: ProductSceneOptions = {}) {
    this.model = model;
    this.units = options.units ?? 'm';
    this.scale = unitScale(this.units);
    this.quality = options.quality ?? 'high';
    const preset = qualitySettings(this.quality);
    this.settings = {
      ...preset,
      edges: options.edges ?? preset.edges,
      curveSegments: options.curveSegments ?? preset.curveSegments,
      merge: options.merge ?? preset.merge,
      textures: options.textures ?? preset.textures,
      hardware:
        options.hardware === true ? 'all' : options.hardware === false ? 'none' : options.hardware ?? preset.hardware,
    };
    this.opts = {
      edges: this.settings.edges,
      edgeColor: options.edgeColor ?? '#2b2b2b',
      edgeOpacity: options.edgeOpacity ?? 0.45,
      roughness: options.roughness,
      curveSegments: this.settings.curveSegments,
      nodeDuration: options.nodeDuration ?? 0.6,
      explodeDuration: options.explodeDuration ?? 0.7,
      explodeFactor: options.explodeFactor ?? 0.6,
      merge: this.settings.merge,
      textures: this.settings.textures,
      highlightColor: options.highlightColor ?? '#ff8a00',
    };
    this.materialConfig = options.materials ?? {};
    this.finishes = { ...DEFAULT_FINISHES, ...(model.hardwareFinishes ?? {}) };
    this.textureLoader = options.textureLoader ?? loadTextureUrl;
    this.loadTexture = options.loadTexture === undefined ? loadTextureAsync : options.loadTexture;
    this.useStudio =
      (options.studioEnvironment ?? true) && this.settings.environment !== 'none' && this.settings.materialModel !== 'lambert';
    this.highlightColor = new Color(this.opts.highlightColor);
    this.dimOptions = typeof options.dimensions === 'object' ? options.dimensions : {};
    this.root = new Group();
    this.root.name = 'product';

    this.edgeMaterial = this.opts.edges
      ? new LineBasicMaterial({
          color: this.opts.edgeColor,
          transparent: this.opts.edgeOpacity < 1,
          opacity: this.opts.edgeOpacity,
        })
      : null;

    for (const node of model.nodes) {
      const pivot = new Group();
      pivot.name = `node:${node.id}`;
      const origin = coreToThree(node.origin, this.scale);
      pivot.position.copy(origin);
      pivot.userData.nodeId = node.id;
      this.root.add(pivot);
      this.nodes.set(node.id, {
        node,
        pivot,
        origin,
        axis: axisToThree(node.axis).normalize(),
        parts: [],
        hardware: [],
        lights: [],
        progress: 0,
        target: 0,
      });
    }

    for (const part of model.parts) {
      const handle = this.buildPart(part);
      this.parts.push(handle);
      const nodeHandle = part.node ? this.nodes.get(part.node) : undefined;
      if (nodeHandle) {
        // Геометрия запечена в координатах изделия; внутри узла сдвигаем на −origin.
        handle.mesh.position.copy(nodeHandle.origin).negate();
        handle.mesh.userData.basePosition = handle.mesh.position.clone();
        nodeHandle.pivot.add(handle.mesh);
        nodeHandle.parts.push(handle);
      } else {
        this.root.add(handle.mesh);
      }
      this.closedBounds.union(handle.mesh.geometry.boundingBox!);
    }

    // Детали, у которых узел не найден, считаем неподвижными (они уже в root).
    const center = this.closedBounds.getCenter(new Vector3());
    for (const h of this.parts) {
      h.explodeOffset.copy(h.center).sub(center).multiplyScalar(this.opts.explodeFactor);
    }
    this.buildHardware();
    if (this.opts.merge) {
      this.buildMerged();
      this.buildMergedHardware();
    }
    this.buildLights();
    if (options.room !== false) this.room = this.buildRoom();
    if (options.ao ?? this.settings.ao) this.ao = this.buildAo();
    if (options.dimensions) this.showDimensions(true);
    this.root.updateMatrixWorld(true);
  }

  // ---------- Материалы ----------

  /** Тип поверхности материала (с учётом options.materials). */
  materialTypeOf(id: string): MaterialType {
    if (id.startsWith('hw:')) return this.finishes[id.slice(3)]?.metal ? 'metal' : 'matte';
    const custom = this.customTypes.get(id);
    if (custom) return custom;
    if (id.startsWith('vc:')) return this.materialTypeOf(id.slice(3).split('|')[0]!);
    return this.materialConfig[id]?.type ?? materialType(id, this.model.materials[id]);
  }

  private textureFor(id: string, type: MaterialType): Texture | null {
    if (!this.opts.textures) return null;
    const cfg = this.materialConfig[id];
    if (cfg?.map instanceof Texture) return cfg.map;
    if (typeof cfg?.map === 'string') {
      const t = this.textureLoader(cfg.map);
      if (t) this.ownedTextures.push(t);
      return t;
    }
    const def = this.model.materials[id];
    const scan = this.scans.get(id);
    if (scan) return scan;
    if (def?.texture && this.loadTexture) this.requestScan(id, def.texture);
    const wantsGrain = cfg?.proceduralGrain ?? (Boolean(def?.hasGrain) || type === 'veneer');
    if (!wantsGrain) return null;
    return this.grainFor(id);
  }

  /** Шаг UV материала, мм на единицу UV: [вдоль волокон, поперёк] (UV запекаются в геометрию). */
  private uvUnit(id: string): [number, number] {
    const t = this.materialConfig[id]?.tileMm ?? 1000;
    return typeof t === 'number' ? [t, t] : t;
  }

  /** Процедурные волокна в реальном масштабе: повтор = шаг UV / размер плитки (одна картинка на GPU). */
  private grainFor(id: string): Texture {
    if (!this.grainTexture) {
      const size = this.settings.textureSize;
      let base = sharedGrain.get(size);
      if (!base) sharedGrain.set(size, (base = createWoodGrainTexture(size)));
      this.grainTexture = base;
    }
    const unit = this.uvUnit(id);
    const key = unit.join('x');
    let t = this.grainByUnit.get(key);
    if (!t) {
      t = this.grainTexture.clone();
      t.repeat.set(unit[0] / GRAIN_TILE_MM[0], unit[1] / GRAIN_TILE_MM[1]);
      this.ownedTextures.push(t);
      this.grainByUnit.set(key, t);
    }
    return t;
  }

  /** Скан декора из модели: грузим один раз; по приходу — во все материалы этого id (и подсветки). */
  private requestScan(id: string, url: string): void {
    if (this.scanRequests.has(id) || !this.loadTexture) return;
    this.scanRequests.add(id);
    this.loadTexture(url)
      .then((base) => {
        if (!base || this.disposed) return;
        const size = this.model.materials[id]?.textureSizeMm;
        const [su, sv] = Array.isArray(size) && size[0]! > 0 && size[1]! > 0 ? size : [1000, 1000];
        const unit = this.uvUnit(id);
        base.wrapS = RepeatWrapping;
        base.wrapT = RepeatWrapping;
        base.colorSpace = SRGBColorSpace;
        if (!base.anisotropy || base.anisotropy < 4) base.anisotropy = 4;
        const t = base.clone();
        t.repeat.set(unit[0] / su, unit[1] / sv);
        this.ownedTextures.push(base, t);
        this.scans.set(id, t);
        const ofId = (key: string) => key === id || (key.startsWith('vc:') && key.slice(3).split('|')[0] === id);
        for (const map of [this.materials, this.highlightMaterials]) {
          for (const [key, m] of map) {
            if (!ofId(key)) continue;
            m.map = t;
            // Скан не тонируем цветом декора
            if (!this.materialConfig[id]?.color) m.color.set('#ffffff');
            m.needsUpdate = true;
          }
        }
        this.onChange?.();
      })
      .catch(() => undefined);
  }

  private material(id: string): ProductMaterial {
    let m = this.materials.get(id);
    if (!m && id.startsWith('hw:')) {
      // Отделка фурнитуры: металл (с отражениями окружения) или пластик
      const f = this.finishes[id.slice(3)] ?? DEFAULT_FINISHES.steel!;
      m = createMaterial({
        id,
        def: { name: f.name, color: f.color, hasGrain: false },
        // Без карты окружения полный металл чёрный (приложение её не ставит) — тогда «полуметалл»
        config: { type: f.metal ? 'metal' : 'matte', roughness: f.roughness, metalness: f.metal ? METAL_NO_ENV : 0 },
        model: this.settings.materialModel,
        map: null,
        polygonOffset: false,
      });
      this.materials.set(id, m);
      this.applyEnv(m, id);
    }
    if (!m && id.startsWith('paint:')) {
      // Покраска: цвет вместо текстуры декора, блеск → шероховатость; цвет вершин — для пазов и накладок
      const [, color, gloss] = id.split('|')[0]!.split(':');
      const type = this.materialTypeOf(id);
      m = createMaterial({
        id,
        def: { name: id, color: color ?? '#e8e4dc', hasGrain: false },
        config: { type, roughness: paintRoughness(gloss), vertexColors: true },
        model: this.settings.materialModel,
        map: null,
        polygonOffset: this.opts.edges,
      });
      this.attachInlay(m, id);
      this.materials.set(id, m);
      this.applyEnv(m, id);
    }
    if (!m && id.startsWith('vc:')) {
      // Декор без покраски (фрезеровка по шпону и т. п.): материал детали + цвет вершин
      const base = id.slice(3).split('|')[0]!;
      const type = this.materialTypeOf(base);
      m = createMaterial({
        id,
        def: this.model.materials[base],
        config: { ...this.materialConfig[base], type, vertexColors: true },
        model: this.settings.materialModel,
        map: this.textureFor(base, type),
        matteRoughness: this.opts.roughness,
        polygonOffset: this.opts.edges,
      });
      if (this.scans.has(base) && !this.materialConfig[base]?.color) m.color.set('#ffffff');
      this.attachInlay(m, id);
      this.materials.set(id, m);
      this.applyEnv(m, id);
    }
    if (!m) {
      const type = this.materialTypeOf(id);
      m = createMaterial({
        id,
        def: this.model.materials[id],
        config: { ...this.materialConfig[id], type },
        model: this.settings.materialModel,
        map: this.textureFor(id, type),
        matteRoughness: this.opts.roughness,
        polygonOffset: this.opts.edges,
      });
      if (this.scans.has(id) && !this.materialConfig[id]?.color) m.color.set('#ffffff');
      if (type === 'metal' && 'metalness' in m && this.materialConfig[id]?.metalness === undefined) {
        m.metalness = METAL_NO_ENV; // полный металл — когда появится карта окружения (applyEnv)
      }
      this.materials.set(id, m);
      this.applyEnv(m, id);
    }
    return m;
  }

  /** Ключ материала детали с учётом декора (покраска, цвет вершин). */
  private materialKeyOf(part: ViewerPart): string {
    if (!hasDecor(part)) return part.material;
    const inlay = part.decor!.inlay?.[0];
    const suffix = inlay ? `|${inlay.finish ?? 'brass'}` : '';
    const paint = part.decor!.paint;
    if (paint?.color) {
      const gloss = paint.gloss === 'gloss' || paint.gloss === 'satin' ? paint.gloss : 'matte';
      const key = `paint:${paint.color.toLowerCase()}:${gloss}${suffix}`;
      if (!this.customTypes.has(key)) this.customTypes.set(key, gloss === 'gloss' ? 'gloss' : gloss === 'satin' ? 'satin' : 'matte');
      return key;
    }
    return `vc:${part.material}${suffix}`;
  }

  /** Металл вставки в материале фасада: цвет и шероховатость отделки. */
  private attachInlay(m: ProductMaterial, id: string): void {
    const bar = id.indexOf('|');
    if (bar < 0) {
      patchDecorMaterial(m, null);
      return;
    }
    const f = this.finishes[id.slice(bar + 1)] ?? DEFAULT_FINISHES.brass!;
    const color = new Color(f.color);
    if (this.settings.materialModel === 'lambert') color.lerp(new Color('#ffffff'), 0.15);
    const u: InlayUniforms = {
      inlayColor: { value: color },
      inlayRough: { value: f.roughness },
      inlayMetal: { value: f.metal ? METAL_NO_ENV : 0 },
      inlayPaintEnv: { value: 1 },
      inlayMetalEnv: { value: 1 },
    };
    patchDecorMaterial(m, u);
  }

  private buildPart(part: ViewerPart): PartHandle {
    const cfg = this.materialConfig[part.material];
    const placeOpts = {
      scale: this.scale,
      curveSegments: this.opts.curveSegments,
      uv: { tileMm: cfg?.tileMm ?? 1000, grainAxis: cfg?.grainAxis ?? 'u' } as const,
    };
    const materialKey = this.materialKeyOf(part);
    let geometry = placeLocalGeometry(localPartGeometry(part, this.opts.curveSegments), part, placeOpts);
    let edgeSource: BufferGeometry | null = null;
    let inlay: Omit<DecorHandle, 'part'> | null = null;
    if (hasDecor(part)) {
      // Пазы, накладки и вставки — в тот же меш (общий материал, цвет вершин); рёбра — только по самой детали
      edgeSource = geometry;
      addDecorAttributes(geometry);
      const local = localDecorGeometry(part, this.opts.curveSegments);
      if (local.surface) {
        const baseTris = geometry.getAttribute('position').count / 3;
        const surfTris = local.surface.getAttribute('position').count / 3;
        const surf = placeLocalGeometry(local.surface, part, placeOpts);
        const merged = mergeGeometries([geometry, surf]);
        surf.dispose();
        if (merged) {
          merged.computeBoundingBox();
          merged.computeBoundingSphere();
          geometry = merged;
          if (local.inlayFinish && local.inlayStart / 3 < surfTris) {
            const finish = local.inlayFinish;
            inlay = {
              kind: 'inlay',
              finish,
              name: inlayName(finish, local.inlayEdge, this.finishes[finish]?.name),
              triStart: baseTris + local.inlayStart / 3,
              triEnd: baseTris + surfTris,
            };
          }
        }
      }
    }
    const mesh = new Mesh(geometry, this.material(materialKey));
    mesh.name = `part:${part.number}:${part.key}`;
    mesh.userData[PART_TAG] = true;
    mesh.userData.kind = 'part';
    mesh.userData.partNumber = part.number;
    mesh.userData.partKey = part.key;
    mesh.userData.nodeId = part.node;
    mesh.userData.basePosition = new Vector3();

    let edges: LineSegments | null = null;
    if (this.edgeMaterial) {
      edges = new LineSegments(new EdgesGeometry(edgeSource ?? geometry, 25), this.edgeMaterial);
      edges.name = `edges:${part.number}`;
      edges.userData.isEdges = true;
      // Рёбра не участвуют в выборе детали.
      edges.raycast = noRaycast;
      mesh.add(edges);
    }
    if (edgeSource && edgeSource !== geometry) edgeSource.dispose();
    const center = geometry.boundingBox!.getCenter(new Vector3());
    const handle: PartHandle = { part, mesh, edges, center, explodeOffset: new Vector3(), materialKey };
    if (inlay) {
      this.decor.push({ part: handle, ...inlay });
      mesh.userData.inlay = { name: inlay.name, finish: inlay.finish, triStart: inlay.triStart, triEnd: inlay.triEnd };
    }
    return handle;
  }

  private buildHardware(): void {
    const mode = this.settings.hardware;
    if (mode === 'none' || !this.model.hardware?.length) return;
    const byKey = new Map(this.parts.map((h) => [h.part.key, h]));
    const segments = Math.max(8, Math.min(16, this.opts.curveSegments));
    for (const item of this.model.hardware) {
      if (mode === 'visible' && (item.kind === 'hinge' || item.kind === 'slide')) continue;
      const parent = byKey.get(item.part) ?? null;
      // Фасад смотрит против своей оси n (лицевая сторона — локальная z = 0)
      const n = parent ? coreAxisVector(parent.part.placement.n) : null;
      const front = n ? (n.map((c) => -c) as CoreVec3) : undefined;
      const geometry = hardwareGeometry(item, this.scale, segments, { front });
      if (!geometry) continue;
      const mesh = new Mesh(geometry, this.material(`hw:${item.finish}`));
      mesh.name = `hw:${item.id}`;
      mesh.userData[HW_TAG] = true;
      mesh.userData.kind = 'hardware';
      mesh.userData.hardwareId = item.id;
      mesh.userData.hardwareKind = item.kind;
      mesh.userData.hardwareName = item.name;
      mesh.userData.label = item.name; // то же, для обработчиков, читающих label
      mesh.userData.partKey = item.part;
      mesh.userData.nodeId = item.node;
      const nodeHandle = item.node ? this.nodes.get(item.node) : undefined;
      const handle: HardwareHandle = {
        item,
        mesh,
        parent,
        explodeOffset: parent ? parent.explodeOffset.clone() : new Vector3(),
      };
      if (nodeHandle) {
        mesh.position.copy(nodeHandle.origin).negate();
        nodeHandle.pivot.add(mesh);
        nodeHandle.hardware.push(handle);
      } else {
        this.root.add(mesh);
      }
      mesh.userData.basePosition = mesh.position.clone();
      this.hardware.push(handle);
    }
  }

  /**
   * Слияние фурнитуры по отделке: неподвижная — в root, фурнитура узла — внутри его группы.
   */
  private buildMergedHardware(): void {
    type Item = { mesh: Mesh; finish: string; h: { merged?: boolean } };
    const items: Item[] = [
      ...this.hardware.map((h) => ({ mesh: h.mesh, finish: h.item.finish, h })),
    ];
    const groups = new Map<string, { parent: Object3D; list: Item[] }>();
    for (const it of items) {
      const parent = it.mesh.parent;
      if (!parent) continue;
      const key = `${parent.uuid}|${it.finish}`;
      const g = groups.get(key) ?? { parent, list: [] };
      g.list.push(it);
      groups.set(key, g);
    }
    for (const { parent, list } of groups.values()) {
      if (list.length < 2) continue;
      const merged = mergeGeometries(list.map((h) => h.mesh.geometry));
      if (!merged) continue;
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      const mesh = new Mesh(merged, list[0]!.mesh.material);
      mesh.name = `merged-hw:${list[0]!.finish}`;
      mesh.userData.isMerged = true;
      mesh.userData.kind = 'hardware';
      mesh.position.copy(list[0]!.mesh.userData.basePosition as Vector3);
      mesh.raycast = noRaycast;
      parent.add(mesh);
      this.mergedHardware.push(mesh);
      for (const it of list) {
        it.h.merged = true;
        it.mesh.visible = false;
      }
    }
  }

  /**
   * Слияние по материалу: неподвижные детали — один меш (и одни рёбра) на материал;
   * детали узла — свой общий меш внутри группы узла, поэтому двери и ящики
   * по-прежнему двигаются отдельно. Выбор лучом идёт по скрытым мешам деталей.
   */
  private buildMerged(): void {
    const groups = new Map<string, { parent: Object3D; list: PartHandle[] }>();
    for (const h of this.parts) {
      const parent = h.mesh.parent;
      if (!parent) continue;
      const key = `${parent.uuid}|${h.materialKey}`;
      const g = groups.get(key) ?? { parent, list: [] };
      g.list.push(h);
      groups.set(key, g);
    }
    for (const { parent, list } of groups.values()) {
      if (list.length < 2) continue;
      const id = list[0]!.materialKey;
      const merged = mergeGeometries(list.map((h) => h.mesh.geometry));
      if (!merged) continue;
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      const mesh = new Mesh(merged, this.material(id));
      const nodeId = list[0]!.part.node;
      mesh.name = nodeId && parent !== this.root ? `merged:${nodeId}:${id}` : `merged:${id}`;
      mesh.userData.isMerged = true;
      mesh.userData.nodeId = parent === this.root ? null : nodeId;
      mesh.userData.partNumbers = list.map((h) => h.part.number);
      // Внутри узла геометрия сдвинута так же, как у мешей деталей (на −origin).
      mesh.position.copy(list[0]!.mesh.userData.basePosition as Vector3);
      mesh.raycast = noRaycast;
      if (this.edgeMaterial) {
        const eg = mergeGeometries(list.map((h) => h.edges!.geometry));
        if (eg) {
          const edges = new LineSegments(eg, this.edgeMaterial);
          edges.name = `merged-edges:${id}`;
          edges.raycast = noRaycast;
          mesh.add(edges);
        }
      }
      parent.add(mesh);
      this.mergedMeshes.push(mesh);
      for (const h of list) {
        h.merged = true;
        h.mesh.visible = false;
      }
    }
  }

  /** Показываем общий меш, пока нет «взрыва» и «рентгена»; иначе — отдельные детали. */
  private refreshVisibility(): void {
    if (!this.mergedMeshes.length && !this.mergedHardware.length) return;
    const useMerged = this.explodeProgress === 0 && !(this.ghost && this.highlightSet.size > 0);
    for (const m of this.mergedMeshes) m.visible = useMerged;
    for (const h of this.parts) {
      if (h.merged) h.mesh.visible = !useMerged || this.highlightSet.has(h);
    }
    const hwMerged = useMerged && this.hwHighlightSet.size === 0;
    for (const m of this.mergedHardware) m.visible = hwMerged;
    for (const h of this.hardware) if (h.merged) h.mesh.visible = !hwMerged;
  }

  /** Нужна ли карта окружения при текущем качестве. */
  get needsEnvironment(): boolean {
    if (this.settings.environment === 'none') return false;
    if (this.settings.environment === 'all') return this.materials.size > 0;
    for (const id of this.materials.keys()) if (PBR_PRESETS[this.materialTypeOf(id)].reflective) return true;
    return false;
  }

  /** Своя «студия» (CubeUV без PMREM) — пока снаружи нет карты окружения. */
  private studio(): Texture {
    if (!this.studioEnv) {
      sharedStudio ??= createStudioEnvironment();
      this.studioEnv = sharedStudio.clone();
      this.ownedTextures.push(this.studioEnv);
    }
    return this.studioEnv;
  }

  private applyEnv(m: ProductMaterial, id: string): void {
    if (!('envMapIntensity' in m)) return; // Lambert: без отражений
    const type = this.materialTypeOf(id);
    const preset = PBR_PRESETS[type];
    const mode = this.settings.environment;
    // Внешняя карта — по пресету; своя студия — только отражающим (металл, зеркало, глянец, полуматовая краска)
    const env = this.envMap
      ? mode === 'all' || (mode === 'reflective' && preset.reflective)
        ? this.envMap
        : null
      : this.useStudio && preset.reflective
        ? this.studio()
        : null;
    const prev = m.envMap;
    m.envMap = env;
    const on = Boolean(env);
    if (id.startsWith('hw:')) {
      if (this.finishes[id.slice(3)]?.metal) m.metalness = on ? 0.9 : METAL_NO_ENV;
    } else if (type === 'metal' && this.materialConfig[id]?.metalness === undefined) {
      m.metalness = on ? preset.metalness : METAL_NO_ENV;
    }
    // Студия ярче комнаты в точке блика, но темнее в среднем — чуть усиливаем металл
    m.envMapIntensity = preset.envIntensity * (env && env === this.studioEnv && type === 'metal' ? 1.25 : 1);
    const inlay = m.userData.inlayUniforms as InlayUniforms | undefined;
    if (inlay) {
      // Вставка в материале фасада: карта нужна металлу всегда, краске — по своим правилам (множитель в шейдере)
      const metalEnv = this.envMap ?? (this.useStudio ? this.studio() : null);
      const f = this.finishes[id.slice(id.indexOf('|') + 1)];
      m.envMap = metalEnv;
      m.envMapIntensity = 1;
      inlay.inlayPaintEnv.value = env ? preset.envIntensity : 0;
      inlay.inlayMetalEnv.value = metalEnv ? (metalEnv === this.studioEnv ? 1.15 : 0.9) : 0;
      inlay.inlayMetal.value = f?.metal === false ? 0 : metalEnv ? 0.92 : METAL_NO_ENV;
      if (prev !== metalEnv) m.needsUpdate = true;
      return;
    }
    if (prev !== env) m.needsUpdate = true;
  }

  /**
   * Карта окружения (без неё металл и зеркало чёрные). Кому она достаётся, решает
   * пресет: high — всем (слабо матовым, сильно глянцу), medium — металлу, зеркалу,
   * глянцу и акрилу, low — никому.
   * Например: PMREMGenerator(renderer).fromScene(new RoomEnvironment()).texture.
   */
  setEnvironment(envMap: Texture | null): void {
    this.envMap = envMap;
    for (const [id, m] of this.materials) this.applyEnv(m, id);
    for (const [id, m] of this.highlightMaterials) this.applyEnv(m, id);
  }

  // ---------- Тени у стыков (AO) ----------

  /** Полосы-градиенты у стыков неподвижных деталей: один меш, MeshBasic, прозрачный, без записи глубины. */
  private buildAo(): Mesh | null {
    const geometry = contactShadowGeometry(this.model.parts, this.scale);
    if (!geometry) return null;
    const material = new MeshBasicMaterial({
      color: '#ffffff',
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
      // Полосы в 2 мм над гранью + сдвиг глубины: без мерцания и в 16-битном буфере
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
    material.name = 'ao';
    const mesh = new Mesh(geometry, material);
    mesh.name = 'ao';
    mesh.userData.kind = 'ao';
    mesh.userData.isAo = true;
    mesh.raycast = noRaycast;
    mesh.renderOrder = 1;
    this.root.add(mesh);
    return mesh;
  }

  /** AO видно, пока изделие собрано и нет «рентгена». */
  private refreshAo(): void {
    if (this.ao) this.ao.visible = this.explodeProgress === 0 && !(this.ghost && this.highlightSet.size > 0);
  }

  // ---------- Комната (встроенная мебель) ----------

  /**
   * Стены, пол, потолок → один матовый меш (цвета комнаты из model.room.colors).
   * От каждого бокса берём только грань, обращённую внутрь комнаты (к изделию), и рисуем её FrontSide:
   * если камера оказалась за стеной (смотрим сбоку или сверху), грань отсекается сама — стена никогда
   * не закрывает мебель, а видимые стены непрозрачные и «настоящие». Не выбирается лучом, не разлетается,
   * не входит в габарит.
   */
  private buildRoom(): Mesh | null {
    const room = this.model.room;
    const walls = Array.isArray(room?.walls) ? room!.walls : [];
    if (!walls.length || this.closedBounds.isEmpty()) return null;
    const colors = (room as { colors?: { wall?: string; floor?: string; ceiling?: string } }).colors ?? {};
    const safe = (hex: string | undefined, fallback: string) => {
      try {
        return new Color(hex && /^#?[0-9a-f]{6}$/i.test(hex) ? (hex.startsWith('#') ? hex : `#${hex}`) : fallback);
      } catch {
        return new Color(fallback);
      }
    };
    const wallC = safe(colors.wall, '#e4e2de');
    const floorC = safe(colors.floor, '#cbc6be');
    const ceilC = colors.ceiling ? safe(colors.ceiling, '#f2f1ee') : wallC.clone().lerp(new Color('#ffffff'), 0.4);
    const center = this.closedBounds.getCenter(new Vector3());
    const pos: number[] = [];
    const nrm: number[] = [];
    const col: number[] = [];
    for (const w of walls) {
      // формат ядра (room.py): x0..z1; запасной — min/max или box
      const xyz = w as unknown as Partial<Record<'x0' | 'y0' | 'z0' | 'x1' | 'y1' | 'z1', number>>;
      const fromXyz = [xyz.x0, xyz.y0, xyz.z0, xyz.x1, xyz.y1, xyz.z1].every((n) => typeof n === 'number');
      const min = (fromXyz ? [xyz.x0, xyz.y0, xyz.z0]
        : w?.min ?? (w as unknown as { box?: { min: CoreVec3 } })?.box?.min) as CoreVec3 | undefined;
      const max = (fromXyz ? [xyz.x1, xyz.y1, xyz.z1]
        : w?.max ?? (w as unknown as { box?: { max: CoreVec3 } })?.box?.max) as CoreVec3 | undefined;
      if (!Array.isArray(min) || !Array.isArray(max)) continue;
      // Бокс в сцене
      const a = coreToThree(min, this.scale);
      const b = coreToThree(max, this.scale);
      const lo = new Vector3(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z));
      const hi = new Vector3(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z));
      const size = hi.clone().sub(lo);
      // Тонкая ось — нормаль стены; внутренняя грань — со стороны изделия
      const ax = size.x <= size.y && size.x <= size.z ? 'x' : size.y <= size.z ? 'y' : 'z';
      const mid = (lo[ax] + hi[ax]) / 2;
      const sign = center[ax] >= mid ? 1 : -1;
      const plane = sign > 0 ? hi[ax] : lo[ax];
      const [u, v] = (['x', 'y', 'z'] as const).filter((k) => k !== ax) as ['x' | 'y' | 'z', 'x' | 'y' | 'z'];
      const n = new Vector3();
      n[ax] = sign;
      const corner = (cu: number, cv: number) => {
        const p = new Vector3();
        p[ax] = plane;
        p[u] = cu;
        p[v] = cv;
        return p;
      };
      const p00 = corner(lo[u], lo[v]);
      const p10 = corner(hi[u], lo[v]);
      const p11 = corner(hi[u], hi[v]);
      const p01 = corner(lo[u], hi[v]);
      const flip = p10.clone().sub(p00).cross(p01.clone().sub(p00)).dot(n) < 0;
      const tri = flip ? [p00, p11, p10, p00, p01, p11] : [p00, p10, p11, p00, p11, p01];
      const kind = String(w.kind ?? w.id ?? '');
      const c = kind.includes('floor') ? floorC : kind.includes('ceil') ? ceilC : wallC;
      for (const p of tri) {
        pos.push(p.x, p.y, p.z);
        nrm.push(n.x, n.y, n.z);
        col.push(c.r, c.g, c.b);
      }
    }
    if (!pos.length) return null;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    // Матовая, непрозрачная; сдвиг глубины — изделие выигрывает у стены вплотную (боковина у стены ниши)
    const material = new MeshLambertMaterial({
      vertexColors: true,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 4,
    });
    material.name = 'room';
    const mesh = new Mesh(geometry, material);
    mesh.name = 'room';
    mesh.userData.kind = 'room';
    mesh.userData.isRoom = true;
    mesh.raycast = noRaycast;
    this.root.add(mesh);
    return mesh;
  }

  get roomVisible(): boolean {
    return Boolean(this.room?.visible);
  }

  /** Показать/скрыть комнату (стены, пол, потолок). */
  setRoomVisible(on: boolean): void {
    if (this.room) this.room.visible = on;
  }

  // ---------- LED-подсветка ----------

  private ledMaterial(temp: number): MeshBasicMaterial {
    const key = String(temp);
    let m = this.ledMaterials.get(key);
    if (!m) {
      // Без освещения (светится сам); выключен — молочно-серый
      m = new MeshBasicMaterial({ vertexColors: true, color: LED_OFF, toneMapped: false });
      m.name = `led:${key}`;
      this.ledMaterials.set(key, m);
    }
    return m;
  }

  /** Профили, пятна света и PointLight по `model.lights`. */
  private buildLights(): void {
    const list = Array.isArray(this.model.lights) ? this.model.lights : [];
    if (!list.length) return;
    this.root.updateMatrixWorld(true);
    const s = this.scale;
    const byKey = new Map(this.parts.map((h) => [h.part.key, h]));
    const ray = new Raycaster();
    const partMeshes = this.parts.map((h) => h.mesh);
    const backTargets = this.parts.filter((h) => h.part.role !== 'door' && h.part.role !== 'drawer_front').map((h) => h.mesh);
    const hitAlong = (o: Vector3, dir: Vector3, targets: Mesh[], maxDist: number) => {
      ray.set(o, dir);
      ray.far = maxDist;
      for (const hit of ray.intersectObjects(targets, false)) {
        const n = hit.face?.normal.clone().transformDirection(hit.object.matrixWorld);
        if (n && n.dot(dir) < -0.6) return hit;
      }
      return null;
    };
    let points = 0;
    for (const light of list) {
      if (!Array.isArray(light.from) || !Array.isArray(light.to)) continue;
      const a = coreToThree(light.from, s);
      const b = coreToThree(light.to, s);
      if (a.distanceTo(b) < 1e-6) continue;
      const f = ledFrame(a, b);
      const w = (light.profile?.width ?? 17) * s;
      const h = (light.profile?.height ?? 7) * s;
      const groove = light.mount !== 'surface';
      const temp = light.temp ?? 3000;
      const color = kelvinColor(temp);
      const mesh = new Mesh(ledProfileGeometry(f, w, h, groove), this.ledMaterial(temp));
      mesh.geometry.computeBoundingBox();
      mesh.geometry.computeBoundingSphere();
      mesh.name = `led:${light.id}`;
      mesh.userData.kind = 'light';
      mesh.userData.lightId = light.id;
      mesh.userData.partKey = light.part ?? null;
      mesh.raycast = noRaycast;

      // Пятна: на поверхности под профилем и на задней стенке ниши; плюс ореол у рассеивателя
      const mid = a.clone().lerp(b, 0.5);
      const quads: Quad[] = [];
      // Пятна чуть над поверхностью: на iOS (Metal под GL) polygonOffset ненадёжен — плоскость в 0,8 мм «рвётся» по диагонали
      const lift = 3 * s;
      const dists: number[] = [];
      let below: Intersection | null = null;
      for (const k of [0.2, 0.5, 0.8]) {
        const o = a.clone().lerp(b, k).addScaledVector(f.emit, h * 1.5);
        const hit = hitAlong(o, f.emit, partMeshes, 1600 * s);
        if (hit) {
          dists.push(hit.distance + h * 1.5);
          if (k === 0.5 || !below) below = hit;
        }
      }
      const down = dists.length ? dists.sort((x, y) => x - y)[Math.floor(dists.length / 2)]! : 0;
      if (below && down > 0) {
        const across = Math.min(350 * s, Math.max(70 * s, down * 0.75));
        const along = f.length / 2 + Math.min(200 * s, Math.max(30 * s, down * 0.35));
        const c = mid.clone().addScaledVector(f.emit, down - lift);
        quads.push(this.clipQuad({ c, u: f.t.clone().multiplyScalar(along), v: f.side.clone().multiplyScalar(across), normal: f.emit.clone().negate() }, below.object as Mesh));
      }
      // Задняя стенка: ищем по обе стороны поперёк, берём дальнюю вертикальную поверхность (фасады не в счёт)
      let back: Intersection | null = null;
      let backDir: Vector3 | null = null;
      for (const sign of [1, -1]) {
        const dir = f.side.clone().multiplyScalar(sign);
        const o = mid.clone().addScaledVector(f.emit, h * 2 + 25 * s);
        const hit = hitAlong(o, dir, backTargets, 900 * s);
        if (hit && hit.distance > 60 * s && (!back || hit.distance > back.distance)) {
          back = hit;
          backDir = dir;
        }
      }
      if (back && backDir) {
        // Заливка от профиля вниз до поверхности (v = 1 — у профиля)
        const vert = Math.min(450 * s, Math.max(120 * s, (down || 400 * s) * 0.5));
        const c = mid.clone().addScaledVector(backDir, back.distance - lift).addScaledVector(f.emit, vert);
        quads.push(
          this.clipQuad(
            { c, u: f.t.clone().multiplyScalar(f.length / 2 + 40 * s), v: f.emit.clone().multiplyScalar(-vert), normal: backDir.clone().negate(), atlas: 'wash' },
            back.object as Mesh,
          ),
        );
      }
      // Ореол вокруг рассеивателя (виден снизу)
      quads.push({
        c: mid.clone().addScaledVector(f.emit, (groove ? h * 0.2 : h * 1.1) + 0.3 * s),
        u: f.t.clone().multiplyScalar(f.length / 2 + 12 * s),
        v: f.side.clone().multiplyScalar(w * 2.4),
        normal: f.emit.clone(),
      });
      const glowMat = new MeshBasicMaterial({
        map: this.glow(),
        color: color.clone().multiplyScalar(down ? Math.min(1, Math.max(0.3, (400 * s) / down)) : 0.8),
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        // Только постоянный сдвиг: наклонный (factor) под острым углом вытягивает пятно сквозь фасады
        polygonOffset: true,
        polygonOffsetFactor: 0,
        polygonOffsetUnits: -8,
      });
      glowMat.name = `led-glow:${light.id}`;
      const glow = new Mesh(quadsGeometry(quads), glowMat);
      glow.geometry.computeBoundingBox();
      glow.geometry.computeBoundingSphere();
      glow.name = `led-glow:${light.id}`;
      glow.userData.isLedGlow = true;
      glow.raycast = noRaycast;
      glow.visible = false;
      glow.renderOrder = 2;

      let point: PointLight | null = null;
      if (points < MAX_POINT_LIGHTS) {
        // Свет в нише: интенсивность в канделах на метр, пересчёт под единицы сцены
        point = new PointLight(color, 0, 1500 * s, 2);
        point.position.copy(mid).addScaledVector(f.emit, 60 * s);
        point.name = `led-light:${light.id}`;
        point.userData.ledIntensity = 0.06 * Math.min(2, Math.max(0.6, f.length / (600 * s))) * (s * 1000) ** 2;
        points++;
      }

      const parent = (light.part ? byKey.get(light.part) : undefined) ?? null;
      const nodeHandle = light.nodeId ? this.nodes.get(light.nodeId) : undefined;
      const handle: LightHandle = {
        light,
        mesh,
        glow,
        point,
        parent,
        explodeOffset: parent ? parent.explodeOffset : new Vector3(),
        color,
      };
      if (nodeHandle) {
        mesh.position.copy(nodeHandle.origin).negate();
        glow.position.copy(mesh.position);
        if (point) point.position.sub(nodeHandle.origin);
        nodeHandle.pivot.add(mesh, glow);
        if (point) nodeHandle.pivot.add(point);
        nodeHandle.lights.push(handle);
      } else {
        this.root.add(mesh, glow);
        if (point) this.root.add(point);
      }
      mesh.userData.basePosition = mesh.position.clone();
      this.lights.push(handle);
    }
  }

  private glow(): Texture {
    if (!this.glowTexture) {
      this.glowTexture = createGlowTexture();
      this.ownedTextures.push(this.glowTexture);
    }
    return this.glowTexture;
  }

  /** Обрезка пятна по габариту детали, на которую оно падает (UV — от необрезанного, градиент на месте). */
  private clipQuad(q: Quad, target: Mesh): Quad {
    const bb = target.geometry.boundingBox!.clone().applyMatrix4(target.matrixWorld);
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map(
      (i) => new Vector3(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z),
    );
    const range = (axis: Vector3) => {
      const len = axis.length();
      const dir = axis.clone().divideScalar(len);
      const c0 = q.c.dot(dir);
      let lo = Infinity;
      let hi = -Infinity;
      for (const p of corners) {
        const d = p.dot(dir) - c0;
        lo = Math.min(lo, d);
        hi = Math.max(hi, d);
      }
      // В долях прямоугольника [−len, len] → [0, 1]
      return [Math.max(0, (lo + len) / (2 * len)), Math.min(1, (hi + len) / (2 * len))] as const;
    };
    const [u0, u1] = range(q.u);
    const [v0, v1] = range(q.v);
    return { ...q, u0, u1: Math.max(u0, u1), v0, v1: Math.max(v0, v1) };
  }

  /** Пятна видны, когда свет включён и нет «взрыва». */
  private refreshLights(): void {
    for (const l of this.lights) {
      if (l.glow) l.glow.visible = this.lightsOnState && this.explodeProgress === 0;
    }
  }

  get hasLights(): boolean {
    return this.lights.length > 0;
  }

  get lightsOn(): boolean {
    return this.lightsOnState;
  }

  /**
   * Включить подсветку: рассеиватели светятся цветом температуры, пятна света под профилями,
   * PointLight в нишах; свет сцены (не свой: hemisphere, directional, ambient) приглушается — «вечер».
   * Выключить — всё как было.
   */
  setLightsOn(on: boolean, options: LightsOnOptions = {}): void {
    this.lightsOnState = on;
    for (const l of this.lights) {
      const m = l.mesh.material as MeshBasicMaterial;
      m.color.copy(on ? l.color : LED_OFF);
      if (l.point) l.point.intensity = on ? (l.point.userData.ledIntensity as number) : 0;
    }
    this.refreshLights();
    if (on) this.dimHostLights(options.dim ?? 0.4);
    else this.restoreHostLights();
  }

  toggleLights(): boolean {
    this.setLightsOn(!this.lightsOnState);
    return this.lightsOnState;
  }

  private ownsObject(o: Object3D): boolean {
    for (let p: Object3D | null = o; p; p = p.parent) if (p === this.root) return true;
    return false;
  }

  private dimHostLights(k: number): void {
    let top: Object3D = this.root;
    while (top.parent) top = top.parent;
    if (top === this.root) return;
    top.traverse((o) => {
      if (!(o as Light).isLight || this.ownsObject(o)) return;
      const light = o as Light;
      if (!this.dimmed.has(light)) this.dimmed.set(light, light.intensity);
      light.intensity = this.dimmed.get(light)! * k;
    });
    const bg = (top as Object3D & { background?: unknown }).background;
    if (bg instanceof Color) {
      if (!this.bgBase || this.bgTarget !== bg) {
        this.bgBase = bg.clone();
        this.bgTarget = bg;
      }
      bg.copy(this.bgBase).multiplyScalar(0.35 + 0.4 * k);
    }
  }

  private restoreHostLights(): void {
    for (const [light, base] of this.dimmed) light.intensity = base;
    this.dimmed.clear();
    if (this.bgBase && this.bgTarget) this.bgTarget.copy(this.bgBase);
    this.bgBase = null;
    this.bgTarget = null;
  }

  // ---------- Подсветка и кадр ----------

  /** Детали, подходящие под цель (номер, ключ, префикс ключа, id узла). */
  partsFor(target: HighlightTarget): PartHandle[] {
    return this.parts.filter((h) => matchesTarget(h.part, target));
  }

  private highlightMaterial(id: string): ProductMaterial {
    let m = this.highlightMaterials.get(id);
    if (!m) {
      const src = this.material(id);
      m = src.clone() as ProductMaterial;
      m.name = `${id}:highlight`;
      // onBeforeCompile не копируется clone() — патч декора заново (те же uniforms)
      if (src.userData.decorPatched) patchDecorMaterial(m, (src.userData.inlayUniforms as InlayUniforms | undefined) ?? null);
      m.emissive = this.highlightColor.clone();
      m.emissiveIntensity = 0.55;
      // Перед общим мешом (у него сдвиг +1 при рёбрах или 0 без них).
      m.polygonOffset = true;
      m.polygonOffsetFactor = this.opts.edges ? 0.5 : -1;
      m.polygonOffsetUnits = this.opts.edges ? 0.5 : -1;
      this.applyEnv(m, id);
      this.highlightMaterials.set(id, m);
    }
    return m;
  }

  private ghostMat(): MeshLambertMaterial {
    if (!this.ghostMaterial) {
      this.ghostMaterial = new MeshLambertMaterial({
        color: '#dcd8d0',
        transparent: true,
        opacity: 0.14,
        depthWrite: false,
      });
      this.ghostMaterial.name = 'ghost';
    }
    return this.ghostMaterial;
  }

  /**
   * Заранее собрать шейдеры «рентгена» и подсветки (без отрисовки), иначе первый тап по детали компилирует их посреди
   * анимации камеры — заметный рывок на iPhone. Вызывать после первого кадра сцены; `scene` — сцена с её светом.
   */
  warmup(renderer: WebGLRenderer, camera: Camera, scene: Scene): void {
    if (this.disposed) return;
    const proxies = new Group();
    const seen = new Set<string>();
    const add = (geometry: BufferGeometry, id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      proxies.add(new Mesh(geometry, this.highlightMaterial(id)));
    };
    for (const h of this.parts) add(h.mesh.geometry, h.materialKey);
    for (const h of this.hardware) add(h.mesh.geometry, `hw:${h.item.finish}`);
    const first = this.parts[0];
    if (first) proxies.add(new Mesh(first.mesh.geometry, this.ghostMat()));
    try {
      renderer.compile(proxies, camera, scene);
      // three читает uniforms/attributes программы лениво — при первом кадре с ней, и ждёт там сборки шейдера.
      // Читаем сразу: вся сборка — здесь, а не посреди анимации
      const programs = (renderer.info.programs ?? []) as unknown as { getUniforms(): unknown; getAttributes(): unknown }[];
      for (const p of programs) {
        p.getUniforms();
        p.getAttributes();
      }
    } catch {
      /* прогрев не обязателен */
    }
  }

  /**
   * Подсветить деталь, узел или секцию (SCR-25, вопросы ИИ «элемент подсвечен в 3D»).
   * Заменяет прежнюю подсветку. Возвращает подсвеченные детали.
   */
  highlight(target: HighlightTarget | null, options: HighlightOptions = {}): PartHandle[] {
    if (options.color) {
      this.highlightColor.set(options.color);
      for (const m of this.highlightMaterials.values()) m.emissive.copy(this.highlightColor);
    }
    const parts = target === null ? [] : this.partsFor(target);
    this.highlightSet = new Set(parts);
    this.ghost = Boolean(options.ghost) && parts.length > 0;
    const ghost = this.ghost ? this.ghostMat() : null;
    for (const h of this.parts) {
      if (this.highlightSet.has(h)) h.mesh.material = this.highlightMaterial(h.materialKey);
      else h.mesh.material = ghost ?? this.material(h.materialKey);
      if (h.edges) h.edges.visible = !ghost || this.highlightSet.has(h);
    }
    // Фурнитура: подсвечена по своему id (или префиксу), с деталью-«родителем» — обычная, иначе «рентген»
    this.hwHighlightSet = new Set(target === null ? [] : this.hardwareFor(target));
    for (const h of this.hardware) {
      const id = `hw:${h.item.finish}`;
      if (this.hwHighlightSet.has(h)) h.mesh.material = this.highlightMaterial(id);
      else if (ghost && !(h.parent && this.highlightSet.has(h.parent))) h.mesh.material = ghost;
      else h.mesh.material = this.material(id);
    }
    this.refreshVisibility();
    this.refreshAo();
    return parts;
  }

  clearHighlight(): void {
    this.highlight(null);
  }

  /** Фурнитура по цели: id элемента или префикс id (ключ двери, узел, секция — вместе с её фурнитурой). */
  hardwareFor(target: HighlightTarget): HardwareHandle[] {
    const list: ReadonlyArray<number | string> = Array.isArray(target) ? target : [target as number | string];
    return this.hardware.filter((h) =>
      list.some(
        (t) => typeof t === 'string' && t !== '' && (h.item.id === t || h.item.id.startsWith(`${t}.`) || h.item.id.startsWith(`${t}[`)),
      ),
    );
  }

  /** Подсвеченные сейчас детали. */
  get highlighted(): PartHandle[] {
    return this.parts.filter((h) => this.highlightSet.has(h));
  }

  /** Габарит деталей цели в текущем положении (двери, «взрыв»), единицы сцены. Пустой, если ничего не нашлось. */
  boundsOf(target: HighlightTarget, out = new Box3()): Box3 {
    this.root.updateMatrixWorld(true);
    out.makeEmpty();
    for (const h of [...this.partsFor(target), ...this.hardwareFor(target)]) {
      out.union(h.mesh.geometry.boundingBox!.clone().applyMatrix4(h.mesh.matrixWorld));
    }
    return out;
  }

  /**
   * Коробка детали L × W × T (по её собственным осям) в текущем положении (двери, «взрыв»): 8 углов в сцене —
   * бит 0 индекса — длина (локальная x), бит 1 — ширина (y), бит 2 — толщина (z) — и размеры в мм (чистовые, из модели).
   * Для размеров «на детали» (ViewRig.focusPart / partAnchors). null — детали с таким номером / ключом нет.
   */
  partBox(target: number | string): { corners: Vector3[]; size: [number, number, number]; part: ViewerPart } | null {
    const h = this.parts.find((p) => (typeof target === 'number' ? p.part.number === target : p.part.key === target));
    if (!h) return null;
    this.root.updateMatrixWorld(true);
    const m = h.mesh.matrixWorld.clone().multiply(partToSceneMatrix(h.part.placement, this.scale));
    const { length: L, width: W, thickness: T } = h.part;
    const corners: Vector3[] = [];
    for (let i = 0; i < 8; i++) corners.push(new Vector3(i & 1 ? L : 0, i & 2 ? W : 0, i & 4 ? T : 0).applyMatrix4(m));
    return { corners, size: [L, W, T], part: h.part };
  }

  /**
   * Камера на цель (или на всё изделие, если target = null). `direction` — откуда
   * смотреть (по умолчанию спереди-справа-сверху, как fitCamera). Для небольших
   * деталей добавляется запас, чтобы было видно, где деталь в изделии.
   */
  frameTarget(
    target: HighlightTarget | null,
    fovDeg = 40,
    aspect = 1,
    direction?: Vector3,
    margin = 1.5,
  ): CameraFit | null {
    const b = target === null ? this.currentBounds() : this.boundsOf(target);
    if (b.isEmpty()) return null;
    // Не подлетаем ближе, чем на ~четверть изделия: иначе теряется контекст.
    const whole = this.closedBounds.getSize(new Vector3()).length();
    const size = b.getSize(new Vector3());
    if (size.length() < whole * 0.25) b.expandByScalar((whole * 0.25 - size.length()) / 2);
    return fitCamera(b, fovDeg, aspect, direction, margin);
  }

  // ---------- Размеры ----------

  /** Значения размеров (габарит, ширины секций) в мм, без построения объектов. */
  dimensionInfo(): DimensionInfo {
    return this.dims?.info ?? computeDimensions(this.model);
  }

  /** Объекты размеров (строятся при первом обращении, скрыты, пока не включены). */
  get dimensions(): DimensionsHandle {
    if (!this.dims) {
      this.dims = buildDimensions(this.model, this.scale, this.dimOptions);
      this.dims.setVisible(false);
      this.root.add(this.dims.group);
    }
    return this.dims;
  }

  /** Показать/скрыть размеры (кнопка «Размеры» в редакторе). */
  showDimensions(on = true): void {
    if (!on && !this.dims) return;
    this.dimensions.setVisible(on);
  }

  toggleDimensions(): boolean {
    this.showDimensions(!this.dimensionsVisible);
    return this.dimensionsVisible;
  }

  get dimensionsVisible(): boolean {
    return this.dims?.visible ?? false;
  }

  // ---------- Узлы: открыть / закрыть ----------

  get hasNodes(): boolean {
    return this.nodes.size > 0;
  }

  /** Сразу поставить узел в положение t (0 — закрыто, 1 — открыто). */
  setNodeOpen(id: string, t: number): void {
    const h = this.nodes.get(id);
    if (!h) return;
    h.progress = Math.min(1, Math.max(0, t));
    h.target = h.progress >= 0.5 ? 1 : 0;
    this.applyNode(h);
  }

  /** Плавно открыть узел (анимация идёт в update()). */
  openNode(id: string): void {
    const h = this.nodes.get(id);
    if (h) h.target = 1;
  }

  closeNode(id: string): void {
    const h = this.nodes.get(id);
    if (h) h.target = 0;
  }

  toggleNode(id: string): void {
    const h = this.nodes.get(id);
    if (h) h.target = h.target > 0.5 ? 0 : 1;
  }

  isNodeOpen(id: string): boolean {
    return (this.nodes.get(id)?.target ?? 0) > 0.5;
  }

  openAll(): void {
    for (const h of this.nodes.values()) h.target = 1;
  }

  closeAll(): void {
    for (const h of this.nodes.values()) h.target = 0;
  }

  /** Сразу открыть/закрыть всё (для экспорта и тестов). */
  setAllOpen(t: number): void {
    for (const id of this.nodes.keys()) this.setNodeOpen(id, t);
  }

  // ---------- «Взрыв» ----------

  /** Сразу поставить «взрыв» в положение t (0 — собрано, 1 — разнесено). */
  setExplode(t: number): void {
    this.explodeProgress = Math.min(1, Math.max(0, t));
    this.explodeTarget = this.explodeProgress >= 0.5 ? 1 : 0;
    this.applyExplode();
  }

  /** Плавно разнести (true) или собрать (false). */
  explode(on: boolean): void {
    this.explodeTarget = on ? 1 : 0;
  }

  get exploded(): boolean {
    return this.explodeTarget > 0.5;
  }

  // ---------- Анимация ----------

  /**
   * Шаг анимации. Вызывать каждый кадр (useFrame / requestAnimationFrame).
   * Возвращает true, пока что-то движется — удобно для frameloop="demand".
   */
  update(dt: number): boolean {
    let moving = false;
    const nodeStep = dt / this.opts.nodeDuration;
    for (const h of this.nodes.values()) {
      if (h.progress !== h.target) {
        h.progress =
          h.target > h.progress ? Math.min(h.target, h.progress + nodeStep) : Math.max(h.target, h.progress - nodeStep);
        this.applyNode(h);
        moving = true;
      }
    }
    if (this.explodeProgress !== this.explodeTarget) {
      const step = dt / this.opts.explodeDuration;
      this.explodeProgress =
        this.explodeTarget > this.explodeProgress
          ? Math.min(this.explodeTarget, this.explodeProgress + step)
          : Math.max(this.explodeTarget, this.explodeProgress - step);
      this.applyExplode();
      moving = true;
    }
    if (moving) this.root.updateMatrixWorld(true);
    return moving;
  }

  get animating(): boolean {
    if (this.explodeProgress !== this.explodeTarget) return true;
    for (const h of this.nodes.values()) if (h.progress !== h.target) return true;
    return false;
  }

  private applyNode(h: NodeHandle): void {
    const t = easeInOut(h.progress);
    const { node, pivot } = h;
    if (node.kind === 'rotate' || node.kind === 'lift') {
      const angle = (node.range * Math.PI) / 180;
      pivot.position.copy(h.origin);
      pivot.quaternion.setFromAxisAngle(h.axis, angle * t);
    } else {
      pivot.quaternion.identity();
      pivot.position.copy(h.origin).addScaledVector(h.axis, node.range * this.scale * t);
    }
    pivot.updateMatrixWorld(true);
    if (this.explodeProgress > 0) {
      this.applyExplodeTo(h.parts);
      this.applyExplodeTo(h.hardware);
      this.applyExplodeTo(h.lights);
    }
  }

  private applyExplode(): void {
    this.applyExplodeTo(this.parts);
    this.applyExplodeTo(this.hardware);
    this.applyExplodeTo(this.lights);
    this.refreshVisibility();
    this.refreshLights();
    this.refreshAo();
  }

  private applyExplodeTo(parts: ReadonlyArray<{ mesh: Mesh; explodeOffset: Vector3 }>): void {
    const t = easeInOut(this.explodeProgress);
    for (const h of parts) {
      const base = h.mesh.userData.basePosition as Vector3;
      tmpV.copy(h.explodeOffset).multiplyScalar(t);
      const parent = h.mesh.parent;
      if (parent && parent !== this.root) {
        // Смещение задано в осях изделия; переводим в оси повернутого узла.
        tmpQ.copy(parent.quaternion).invert();
        tmpV.applyQuaternion(tmpQ);
      }
      h.mesh.position.copy(base).add(tmpV);
    }
  }

  // ---------- Выбор детали ----------

  /** Все меши деталей (без рёбер) — для своего raycast. В режиме слияния часть из них скрыта, но луч их видит. */
  get meshes(): Mesh[] {
    return this.parts.map((p) => p.mesh);
  }

  /** Деталь по объекту сцены (меш или его потомок). */
  partFromObject(obj: Object3D | null | undefined): PartHandle | null {
    let o: Object3D | null | undefined = obj;
    while (o) {
      if (o.userData[PART_TAG]) {
        const num = o.userData.partNumber as number;
        return this.parts.find((p) => p.part.number === num) ?? null;
      }
      o = o.parent;
    }
    return null;
  }

  /** Фурнитура по объекту сцены (меш фурнитуры). */
  hardwareFromObject(obj: Object3D | null | undefined): HardwareHandle | null {
    if (!obj?.userData[HW_TAG]) return null;
    const id = obj.userData.hardwareId as string;
    return this.hardware.find((h) => h.item.id === id) ?? null;
  }

  /** Вставка фасада по мешу детали и номеру треугольника (faceIndex попадания). */
  decorFromHit(obj: Object3D | null | undefined, faceIndex: number | null | undefined): DecorHandle | null {
    if (!obj?.userData[PART_TAG] || faceIndex === null || faceIndex === undefined) return null;
    const num = obj.userData.partNumber as number;
    return this.decor.find((d) => d.part.part.number === num && faceIndex >= d.triStart && faceIndex < d.triEnd) ?? null;
  }

  /**
   * Результат выбора по объекту сцены: деталь, вставка (с фасадом) или фурнитура (с деталью-«родителем»).
   * faceIndex — номер треугольника попадания: по нему видно, что попали в металлическую вставку.
   */
  pickFromObject(obj: Object3D | null | undefined, point: Vector3, distance: number, faceIndex?: number | null): PickResult | null {
    const dec = this.decorFromHit(obj, faceIndex);
    if (dec) {
      return {
        ...toPickResult(dec.part, { point, distance }),
        kind: 'decor',
        decor: { kind: 'inlay', name: dec.name, finish: dec.finish },
      };
    }
    const hw = this.hardwareFromObject(obj);
    if (hw) {
      if (!hw.parent) return null;
      return {
        ...toPickResult(hw.parent, { point, distance }),
        kind: 'hardware',
        hardware: { id: hw.item.id, kind: hw.item.kind, name: hw.item.name },
      };
    }
    const h = this.partFromObject(obj);
    return h ? toPickResult(h, { point, distance }) : null;
  }

  /** Луч → ближайшая деталь или фурнитура (номер, ключ, узел; у фурнитуры — ещё `hardware`). */
  pick(raycaster: Raycaster): PickResult | null {
    this.root.updateMatrixWorld(true);
    const targets: Mesh[] = [...this.meshes, ...this.hardware.map((h) => h.mesh)];
    const hits: Intersection[] = raycaster.intersectObjects(targets, false);
    for (const hit of hits) {
      const r = this.pickFromObject(hit.object, hit.point, hit.distance, hit.faceIndex);
      if (r) return r;
    }
    return null;
  }

  /**
   * Выбор детали по точке экрана в нормализованных координатах
   * (x, y ∈ [−1, 1], y вверх). Не зависит от DOM.
   */
  pickAt(camera: Camera, ndcX: number, ndcY: number): PickResult | null {
    const raycaster = new Raycaster();
    raycaster.setFromCamera(new Vector2(ndcX, ndcY), camera);
    return this.pick(raycaster);
  }

  // ---------- Габариты ----------

  /** Текущий габарит (с учётом открытых дверей и «взрыва»), единицы сцены. */
  currentBounds(target = new Box3()): Box3 {
    this.root.updateMatrixWorld(true);
    target.makeEmpty();
    for (const h of this.parts) {
      const bb = h.mesh.geometry.boundingBox!;
      target.union(bb.clone().applyMatrix4(h.mesh.matrixWorld));
    }
    return target;
  }

  /** Сколько вызовов отрисовки и треугольников даёт сцена сейчас (без тени и фона). */
  stats(): SceneStats {
    this.root.updateMatrixWorld(true);
    return sceneStats(this.root);
  }

  dispose(): void {
    for (const h of this.parts) {
      h.mesh.geometry.dispose();
      h.edges?.geometry.dispose();
    }
    this.restoreHostLights();
    for (const h of this.hardware) h.mesh.geometry.dispose();
    for (const l of this.lights) {
      l.mesh.geometry.dispose();
      l.glow?.geometry.dispose();
      (l.glow?.material as MeshBasicMaterial | undefined)?.dispose();
      l.point?.dispose();
    }
    for (const m of this.ledMaterials.values()) m.dispose();
    this.disposed = true;
    this.onChange = null;
    if (this.ao) {
      this.ao.geometry.dispose();
      (this.ao.material as MeshBasicMaterial).dispose();
    }
    if (this.room) {
      this.room.geometry.dispose();
      (this.room.material as MeshLambertMaterial).dispose();
    }
    for (const m of this.mergedHardware) m.geometry.dispose();
    for (const m of this.mergedMeshes) {
      m.geometry.dispose();
      for (const c of m.children) if (c instanceof LineSegments) (c.geometry as BufferGeometry).dispose();
    }
    for (const m of this.materials.values()) m.dispose();
    for (const m of this.highlightMaterials.values()) m.dispose();
    this.ghostMaterial?.dispose();
    for (const t of this.ownedTextures) t.dispose();
    this.edgeMaterial?.dispose();
    this.dims?.dispose();
    this.root.removeFromParent();
    this.root.clear();
  }
}

function toPickResult(h: PartHandle, hit: { point: Vector3; distance: number }): PickResult {
  return {
    kind: 'part',
    number: h.part.number,
    key: h.part.key,
    name: h.part.name,
    role: h.part.role,
    node: h.part.node,
    point: [hit.point.x, hit.point.y, hit.point.z],
    distance: hit.distance,
  };
}

/** Удобная обёртка: построить сцену изделия. */
export function buildProduct(model: ViewerModel, options?: ProductSceneOptions): ProductScene {
  return new ProductScene(model, options);
}
