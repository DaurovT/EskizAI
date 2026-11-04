/**
 * Фото клиента (.photo r28) с рамками найденных предметов (DesignOut.objects) — Recognition*.dc.html.
 * Мультивыбор (SCR-05b): `picked` — номера выбранных в полном списке objects; рамка выбранного — белое кольцо 3 + зелёное 2,
 * невыбранного — белое 2 и прозрачность .75; над рамкой — метка `.pin` с номером. Одиночный выбор: `selected` / `onSelect`.
 * Фото вписывается «cover», рамки пересчитываются под обрезку. `children` — свои метки поверх (SCR-05).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Image, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import type { DesignObject } from '../api/types';
import { resolveFont } from './base';
import { palette, type } from './theme';

/** Геометрия «cover»: где на экране окажется точка (fx, fy) фото с пропорцией ratio в рамке W×H. */
export function coverMap(W: number, H: number, ratio: number) {
  const iw = Math.max(W, H * ratio);
  const ih = iw / ratio;
  const ox = (W - iw) / 2;
  const oy = (H - ih) / 2;
  return (fx: number, fy: number) => ({ x: ox + fx * iw, y: oy + fy * ih });
}

/** Пропорция фото (по умолчанию 4:3, пока не узнали). */
export function usePhotoRatio(uri?: string | null, fallback = 4 / 3) {
  const [ratio, setRatio] = useState(fallback);
  useEffect(() => {
    if (uri) Image.getSize(uri, (iw, ih) => ih && setRatio(iw / ih), () => undefined);
  }, [uri]);
  return ratio;
}

/** .pin — белая метка h30–32 r16 с тенью; on — зелёная; n — номер в кружке; dot — цветная точка; q — янтарная «под вопросом». */
export function Pin({ label, n, on, dot, q, style }: { label: string; n?: number; on?: boolean; dot?: string; q?: boolean; style?: StyleProp<ViewStyle> }) {
  const fg = on ? palette.white : q ? '#6E3C00' : palette.ink;
  return (
    <View style={[st.pin, n != null ? st.pinN : null, on && { backgroundColor: palette.green }, q && { backgroundColor: palette.amberSoft }, style]}>
      {n != null ? <View style={[st.n, on && { backgroundColor: 'rgba(255,255,255,0.22)' }]}><Text style={resolveFont([st.nText, { color: fg }])}>{n}</Text></View> : null}
      {dot ? <View style={[st.dot, { backgroundColor: dot }]} /> : null}
      <Text style={resolveFont([st.pinText, { color: fg }])} numberOfLines={1}>{label}</Text>
    </View>
  );
}

/** Метка над рамкой: у верхнего края — на рамке (−12), иначе над ней (−40); не влезает справа — по правому краю рамки. */
function PinAt({ box, w, onPress, children }: { box: { left: number; top: number; width: number }; w: number; onPress: () => void; children: ReactNode }) {
  const [pw, setPw] = useState(0);
  const right = box.left + box.width;
  const left = box.left + 8 + pw > w - 8 ? Math.max(8, right - pw) : box.left + 8;
  const top = box.top >= 48 ? box.top - 40 : Math.max(8, box.top - 12);
  return (
    <Pressable onPress={onPress} accessible={false} onLayout={(e) => setPw(e.nativeEvent.layout.width)}
      style={{ position: 'absolute', left, top, maxWidth: w - 16, opacity: pw ? 1 : 0 }}>
      {children}
    </Pressable>
  );
}

export function PhotoBoxes({ uri, objects, selected, onSelect, picked, onToggle, photo, height = 236, tint, children, style }: {
  uri: string; objects: DesignObject[]; selected?: string | null; onSelect?: (label: string) => void;
  picked?: number[]; onToggle?: (index: number) => void;
  /** Рамки только этого фото (по умолчанию — фото первого предмета). */
  photo?: number;
  height?: number; tint?: string; children?: ReactNode; style?: StyleProp<ViewStyle>;
}) {
  const [w, setW] = useState(0);
  const ratio = usePhotoRatio(uri, w ? w / height : 4 / 3);
  const multi = !!picked;
  const shown = photo ?? objects[0]?.photo ?? 0;
  const map = coverMap(w, height, uri ? ratio : (w || 1) / height);
  return (
    <View onLayout={(e) => setW(e.nativeEvent.layout.width)} style={[st.photo, { height, backgroundColor: tint ?? '#CDBFA8' }, style]}>
      {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
      {w > 0 && objects.map((o, i) => {
        if (o.photo !== shown) return null;
        const a = map(o.box[0], o.box[1]);
        const b = map(o.box[2], o.box[3]);
        const on = multi ? picked.includes(i) : selected ? selected === o.label : o.chosen;
        const box = { left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y };
        return (
          <View key={`${i}-${o.label}`} pointerEvents="box-none" style={StyleSheet.absoluteFill}>
            <Pressable
              accessibilityRole={multi ? 'checkbox' : 'button'}
              accessibilityLabel={multi ? `${i + 1}. ${o.label}` : o.label}
              accessibilityState={multi ? { checked: on } : { selected: on }}
              onPress={() => (multi ? onToggle?.(i) : onSelect?.(o.label))}
              style={[st.box, box]}
            >
              {on ? (
                <>
                  <View pointerEvents="none" style={[st.ring, { top: -5, left: -5, right: -5, bottom: -5, borderRadius: 19, borderWidth: 2, borderColor: palette.green }]} />
                  <View pointerEvents="none" style={[st.ring, { top: -3, left: -3, right: -3, bottom: -3, borderRadius: 17, borderWidth: 3, borderColor: palette.white }]} />
                </>
              ) : (
                <View pointerEvents="none" style={[st.ring, { top: -2, left: -2, right: -2, bottom: -2, borderRadius: 16, borderWidth: 2, borderColor: 'rgba(255,255,255,0.8)', opacity: 0.75 }]} />
              )}
            </Pressable>
            <PinAt box={box} w={w} onPress={() => (multi ? onToggle?.(i) : onSelect?.(o.label))}>
              <Pin label={o.label.length > 12 ? o.label.split(' ')[0] : o.label} n={multi ? i + 1 : undefined} on={on} dot={multi ? undefined : on ? palette.green : undefined} />
            </PinAt>
          </View>
        );
      })}
      {children}
    </View>
  );
}

const st = StyleSheet.create({
  photo: { borderRadius: 28, overflow: 'hidden' },
  box: { position: 'absolute', borderRadius: 14 },
  ring: { position: 'absolute' },
  pin: {
    flexDirection: 'row', alignItems: 'center', gap: 6, height: 32, paddingHorizontal: 12, borderRadius: 16, backgroundColor: palette.white, alignSelf: 'flex-start',
    shadowColor: palette.ink, shadowOpacity: 0.16, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 4, maxWidth: 260,
  },
  pinN: { height: 30, borderRadius: 15, paddingLeft: 6, paddingRight: 10 },
  pinText: { ...type.rs, fontSize: 14, lineHeight: 19, fontWeight: '500', color: palette.ink, flexShrink: 1 },
  n: { width: 20, height: 20, borderRadius: 10, backgroundColor: palette.ground, alignItems: 'center', justifyContent: 'center' },
  nText: { fontSize: 12, lineHeight: 15, fontWeight: '700' },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
