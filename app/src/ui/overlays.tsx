/**
 * Шторка .bs, окно .dlg, тост .toast (V3). Анимации — Motion.dc.html:
 * шторка 320 мс (.32,.72,0,1), фон 200 мс; окно — прозрачность и масштаб с 0.96 за 200 мс; тост — снизу 16 px за 200 мс.
 */
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Animated, Dimensions, KeyboardAvoidingView, Modal, PanResponder, Platform, Pressable, ScrollView, StyleSheet, Text, View,
  type StyleProp, type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useT } from '../i18n';
import { createStore } from '../state/store';
import { Button, Press, SurfaceProvider, T, ease, exitEase, resolveFont, sheetEase, useReduceMotion, useSeparator, type IconName } from './base';
import { haptics } from './haptics';
import { motion, palette, radius, type } from './theme';

// ---------- шторка ----------
/**
 * Нижняя шторка: ручка, затемнение, выезд снизу, закрытие свайпом вниз по ручке/заголовку и тапом по фону.
 * variant 'white' — .bs.white (формы: поля и кнопки внутри серые); 'gray' — .bs (меню из белых Group/Card).
 */
export function Sheet({ visible, onClose, title, children, variant = 'white', footer, scroll = true, contentStyle }: {
  visible: boolean; onClose: () => void; title?: string; children: ReactNode;
  variant?: 'white' | 'gray';
  /** Закреплённые снизу кнопки (не прокручиваются). */
  footer?: ReactNode; scroll?: boolean; contentStyle?: StyleProp<ViewStyle>;
}) {
  const insets = useSafeAreaInsets();
  const { t } = useT();
  const reduce = useReduceMotion();
  const [mounted, setMounted] = useState(visible);
  const shown = useRef(new Animated.Value(0)).current; // 0 — скрыта, 1 — открыта
  const drag = useRef(new Animated.Value(0)).current; // смещение пальцем
  const h = Dimensions.get('window').height;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      drag.setValue(0);
      Animated.timing(shown, { toValue: 1, duration: motion.sheet, easing: sheetEase, useNativeDriver: true }).start();
    } else if (mounted) {
      Animated.timing(shown, { toValue: 0, duration: 240, easing: exitEase, useNativeDriver: true }).start(({ finished }) => { if (finished) setMounted(false); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderMove: (_, g) => drag.setValue(Math.max(0, g.dy)),
    onPanResponderRelease: (_, g) => {
      if (g.dy > 120 || g.vy > 0.5) { haptics.light(); closeRef.current(); }
      else Animated.spring(drag, { toValue: 0, stiffness: 400, damping: 38, mass: 1, useNativeDriver: true }).start();
    },
    onPanResponderTerminate: () => Animated.spring(drag, { toValue: 0, stiffness: 400, damping: 38, mass: 1, useNativeDriver: true }).start(),
  })).current;

  if (!mounted) return null;
  const white = variant === 'white';
  const translateY = reduce ? drag : Animated.add(shown.interpolate({ inputRange: [0, 1], outputRange: [h, 0] }), drag);
  const body = scroll
    ? <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: h * 0.72 }} contentContainerStyle={[st.sheetBody, contentStyle]}>{children}</ScrollView>
    : <View style={[st.sheetBody, contentStyle]}>{children}</View>;
  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <KeyboardAvoidingView style={{ flex: 1, justifyContent: 'flex-end' }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: palette.scrim, opacity: shown }]}>
          <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('close')} />
        </Animated.View>
        <Animated.View
          accessibilityViewIsModal
          style={[st.sheet, { backgroundColor: white ? palette.white : palette.ground, paddingBottom: Math.max(insets.bottom, 16) + 4, transform: [{ translateY }] }, reduce && { opacity: shown }]}
        >
          <SurfaceProvider value={white ? 'white' : 'ground'}>
            <View {...pan.panHandlers}>
              <View style={st.hdl}><View style={st.hdlBar} /></View>
              {title ? <T v="title" style={st.sheetTitle}>{title}</T> : null}
            </View>
            {body}
            {footer ? <View style={st.sheetFoot}>{footer}</View> : null}
          </SurfaceProvider>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** Строка меню в шторке (.mi): иконка, текст, red — красная. Кладите в <Group> внутри Sheet variant="gray". */
export function MenuItem({ icon, title, onPress, red, disabled }: { icon?: IconName; title: string; onPress?: () => void; red?: boolean; disabled?: boolean }) {
  const c = red ? palette.redText : palette.ink;
  const sep = useSeparator();
  return (
    <Press feedback="row" onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={title} style={[st.mi, disabled && { opacity: 0.4 }]}>
      {sep ? <View style={st.sep} /> : null}
      {icon ? <Ionicons name={icon} size={22} color={c} /> : null}
      <Text style={resolveFont([type.rt, { color: c, flex: 1 }])}>{title}</Text>
    </Press>
  );
}

// ---------- окно подтверждения ----------
export function Dialog({ visible, onClose, title, text, children, actions, confirmLabel, cancelLabel, onConfirm, destructive, loading }: {
  visible: boolean; onClose: () => void; title: string; text?: string; children?: ReactNode;
  /** Свои кнопки (ряд .fr); иначе — confirmLabel/cancelLabel. */
  actions?: ReactNode;
  confirmLabel?: string; cancelLabel?: string; onConfirm?: () => void; destructive?: boolean; loading?: boolean;
}) {
  const { t } = useT();
  const reduce = useReduceMotion();
  const [mounted, setMounted] = useState(visible);
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.timing(a, { toValue: 1, duration: motion.el, easing: ease, useNativeDriver: true }).start();
    } else if (mounted) {
      Animated.timing(a, { toValue: 0, duration: 160, easing: exitEase, useNativeDriver: true }).start(({ finished }) => { if (finished) setMounted(false); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);
  if (!mounted) return null;
  const scale = reduce ? 1 : a.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] });
  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(33,32,31,0.40)', opacity: a }]}>
        <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('close')} />
      </Animated.View>
      <View style={st.dlgWrap} pointerEvents="box-none">
        <Animated.View accessibilityViewIsModal accessibilityRole="alert" style={[st.dlg, { opacity: a, transform: [{ scale }] }]}>
          <SurfaceProvider value="white">
            <T v="title">{title}</T>
            {text ? <T v="sub" color={palette.muted2}>{text}</T> : null}
            {children}
            {actions ? <View style={st.fr}>{actions}</View> : (confirmLabel || cancelLabel) ? (
              <View style={st.fr}>
                {cancelLabel ? <Button v="secondary" title={cancelLabel} onPress={onClose} style={{ flex: 1 }} /> : null}
                {confirmLabel ? <Button v={destructive ? 'danger' : 'primary'} title={confirmLabel} onPress={onConfirm} loading={loading} style={{ flex: 1 }} /> : null}
              </View>
            ) : null}
          </SurfaceProvider>
        </Animated.View>
      </View>
    </Modal>
  );
}

/** Императивное окно: `await dialog.confirm({ title, text, confirmLabel, cancelLabel, destructive })` → true/false. Нужен <DialogHost/> в корне. */
type DialogReq = { title: string; text?: string; confirmLabel: string; cancelLabel: string; destructive?: boolean; resolve: (v: boolean) => void };
const dialogStore = createStore<{ req: DialogReq | null; visible: boolean }>({ req: null, visible: false });
export const dialog = {
  confirm(o: Omit<DialogReq, 'resolve'>): Promise<boolean> {
    return new Promise((resolve) => {
      dialogStore.get().req?.resolve(false);
      dialogStore.set({ req: { ...o, resolve }, visible: true });
    });
  },
};
export function DialogHost() {
  const { req, visible } = dialogStore.use((s) => s);
  if (!req) return null;
  const done = (v: boolean) => { req.resolve(v); dialogStore.set({ visible: false }); };
  return (
    <Dialog
      visible={visible}
      onClose={() => done(false)}
      title={req.title}
      text={req.text}
      actions={<>
        <Button v="secondary" title={req.cancelLabel} onPress={() => done(false)} style={{ flex: 1 }} />
        <Button v={req.destructive ? 'danger' : 'primary'} title={req.confirmLabel} onPress={() => done(true)} style={{ flex: 1 }} />
      </>}
    />
  );
}

// ---------- тост ----------
export type ToastOptions = {
  text: string;
  /** Действие справа зелёным (например «Отменить»). С действием тост живёт 6 с, без — 4 с. */
  action?: { label: string; onPress: () => void };
  /** success/error — вибрация «успех»/«ошибка» и иконка. */
  tone?: 'default' | 'success' | 'error';
  duration?: number;
  icon?: IconName;
  /** Отступ снизу над безопасной зоной (по умолчанию 96 — над таб-баром/кнопкой футера). */
  bottom?: number;
};
type ToastState = { cur: (ToastOptions & { id: number }) | null };
const toastStore = createStore<ToastState>({ cur: null });
let toastId = 0;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
export const toast = {
  show(o: ToastOptions | string) {
    const opts = typeof o === 'string' ? { text: o } : o;
    if (opts.tone === 'success') haptics.success();
    if (opts.tone === 'error') haptics.error();
    const id = ++toastId;
    toastStore.set({ cur: { ...opts, id } });
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (toastStore.get().cur?.id === id) toastStore.set({ cur: null }); }, opts.duration ?? (opts.action ? motion.undoMs : motion.toastMs));
  },
  hide() {
    if (toastTimer) clearTimeout(toastTimer);
    toastStore.set({ cur: null });
  },
};

/** Хост тостов: один на приложение, в корневом _layout поверх навигации. */
export function ToastHost() {
  const cur = toastStore.use((s) => s.cur);
  const insets = useSafeAreaInsets();
  const reduce = useReduceMotion();
  const a = useRef(new Animated.Value(0)).current;
  const [shown, setShown] = useState<ToastState['cur']>(null);
  useEffect(() => {
    if (cur) {
      setShown(cur);
      a.setValue(0);
      Animated.timing(a, { toValue: 1, duration: motion.el, easing: ease, useNativeDriver: true }).start();
    } else {
      Animated.timing(a, { toValue: 0, duration: 160, easing: exitEase, useNativeDriver: true }).start(({ finished }) => { if (finished) setShown(null); });
    }
  }, [cur, a]);
  if (!shown) return null;
  const icon = shown.icon ?? (shown.tone === 'success' ? 'checkmark-circle' : shown.tone === 'error' ? 'alert-circle' : undefined);
  const translateY = reduce ? 0 : a.interpolate({ inputRange: [0, 1], outputRange: [16, 0] });
  return (
    <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, { justifyContent: 'flex-end' }]}>
      <Animated.View accessibilityLiveRegion="polite" style={[st.toast, { marginBottom: insets.bottom + (shown.bottom ?? 96), opacity: a, transform: [{ translateY }] }]}>
        {icon ? <Ionicons name={icon} size={20} color={shown.tone === 'error' ? '#FF8A80' : palette.greenOnDark} /> : null}
        <Text style={resolveFont([type.toast, { flex: 1, paddingVertical: 10 }])}>{shown.text}</Text>
        {shown.action ? (
          <Press feedback="opacity" accessibilityRole="button" accessibilityLabel={shown.action.label} style={st.ta}
            onPress={() => { const act = shown.action; toast.hide(); act?.onPress(); }}>
            <Text style={resolveFont([type.toast, { fontWeight: '600', color: palette.greenOnDark }])}>{shown.action.label}</Text>
          </Press>
        ) : null}
      </Animated.View>
    </View>
  );
}

const st = StyleSheet.create({
  sheet: {
    borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, paddingHorizontal: 12,
    shadowColor: palette.ink, shadowOpacity: 0.1, shadowRadius: 24, shadowOffset: { width: 0, height: -4 }, elevation: 12,
  },
  hdl: { height: 22, alignItems: 'center', justifyContent: 'center' },
  hdlBar: { width: 40, height: 5, borderRadius: 3, backgroundColor: palette.handle },
  sheetTitle: { paddingHorizontal: 8, paddingTop: 2, paddingBottom: 8 },
  sheetBody: { gap: 8, paddingBottom: 4 },
  sheetFoot: { gap: 8, paddingTop: 8 },
  mi: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 58, paddingHorizontal: 20 },
  sep: { position: 'absolute', top: 0, left: 0, right: 0, height: 1, backgroundColor: palette.hair },
  dlgWrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center' },
  dlg: {
    marginHorizontal: 12, backgroundColor: palette.white, borderRadius: radius.dlg, paddingTop: 24, paddingHorizontal: 20, paddingBottom: 20, gap: 12,
    shadowColor: palette.ink, shadowOpacity: 0.12, shadowRadius: 32, shadowOffset: { width: 0, height: 12 }, elevation: 16,
  },
  fr: { flexDirection: 'row', gap: 8, marginTop: 8 },
  toast: {
    marginHorizontal: 12, minHeight: 56, borderRadius: radius.toast, backgroundColor: palette.ink,
    flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 18, paddingRight: 8,
  },
  ta: { minHeight: 44, paddingHorizontal: 12, justifyContent: 'center' },
});
