/**
 * Чертежи из Eskiz DWG: превью листа (белая плашка r8 с тонкой рамкой, как в MInbox / MInboxItem), значок Eskiz DWG.
 * Превью мока — `mock:<имя>` → картинки assets/mock (scripts/gen_mock_dwg.py); настоящие — WebP по подписанной ссылке.
 */
import { Ionicons } from '@expo/vector-icons';
import { Image, StyleSheet, View, type ImageResizeMode, type ImageSourcePropType, type StyleProp, type ViewStyle } from 'react-native';
import { palette } from './theme';

const MOCK: Record<string, ImageSourcePropType> = {
  dwg_kitchen_plan: require('../../assets/mock/dwg_kitchen_plan.png'),
  dwg_kitchen_elev: require('../../assets/mock/dwg_kitchen_elev.png'),
  dwg_kupe: require('../../assets/mock/dwg_kupe.png'),
  dwg_hallway: require('../../assets/mock/dwg_hallway.png'),
};

/** Ссылка превью → source для Image (null — превью нет). */
export function drawingSource(uri: string | null | undefined): ImageSourcePropType | null {
  if (!uri) return null;
  if (uri.startsWith('mock:')) return MOCK[uri.slice(5)] ?? null;
  return { uri };
}

/** Превью листа целиком (contain) на белом; без превью — значок листа. */
export function DrawingImage({ uri, resizeMode = 'contain', style }: { uri: string | null | undefined; resizeMode?: ImageResizeMode; style?: StyleProp<ViewStyle> }) {
  const src = drawingSource(uri);
  return (
    <View style={[{ backgroundColor: palette.white, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }, style]}>
      {/* размер явно: иначе у локальной картинки остаётся её собственная ширина/высота и contain не срабатывает */}
      {src ? <Image source={src} style={[StyleSheet.absoluteFill, { width: '100%', height: '100%' }]} resizeMode={resizeMode} accessibilityIgnoresInvertColors />
        : <Ionicons name="document-outline" size={22} color={palette.chev} />}
    </View>
  );
}

/** Миниатюра 64×46 r8 с рамкой #E6E5E1 (выбранный лист — зелёная рамка 2). */
export function DrawingThumb({ uri, width = 64, height = 46, selected, style }: {
  uri: string | null | undefined; width?: number; height?: number; selected?: boolean; style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[{ width, height, borderRadius: 8 }, style]}>
      <DrawingImage uri={uri} style={{ flex: 1, borderRadius: 8 }} />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: 8, borderWidth: selected ? 2 : 1, borderColor: selected ? palette.green : '#E6E5E1' }]} />
    </View>
  );
}

/** Плитка приложения Eskiz DWG: тёмная #1F2937 со знаком DWG. */
export function DwgAppIcon({ size = 40, radius }: { size?: number; radius?: number }) {
  const m = Math.round(size * 0.6);
  return (
    <View style={{ width: size, height: size, borderRadius: radius ?? Math.round(size * 0.23), backgroundColor: '#1F2937', alignItems: 'center', justifyContent: 'center' }}>
      <Image source={require('../../assets/brand/dwg-mark.png')} style={{ width: m, height: m }} accessibilityIgnoresInvertColors />
    </View>
  );
}
