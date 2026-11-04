/**
 * DIAG-маршрут (только при EXPO_PUBLIC_DIAG=1): образец кухни из schemas/samples в том же ProductCanvas, что и редактор.
 * Открывается без входа и без проектов на сервере: mebelmaster://diag. Результат — плашка под 3D и Documents/diag.log.
 * Без DIAG маршрут сразу уходит на главный экран.
 */
import { parseViewerModel } from '@mebel/viewer';
import { Redirect } from 'expo-router';
import { useMemo, useRef } from 'react';
import { View } from 'react-native';
import kitchen from '../../schemas/samples/kitchen_straight.viewer.json';
import { DIAG, diagLog } from '../src/diag';
import { ProductCanvas, type CanvasHandle } from '../src/three/ProductCanvas';
import { Button } from '../src/ui/kit';

export default function DiagScreen() {
  const canvas = useRef<CanvasHandle>(null);
  const model = useMemo(() => {
    if (!DIAG) return null;
    diagLog('route /diag: kitchen_straight');
    return parseViewerModel(kitchen as unknown);
  }, []);
  if (!DIAG || !model) return <Redirect href="/" />;
  return (
    <View style={{ flex: 1 }}>
      <ProductCanvas ref={canvas} model={model} fallbackText="3D недоступно" />
      <View style={{ flexDirection: 'row', gap: 8, padding: 12 }}>
        <View style={{ flex: 1 }}><Button v="secondary" title="Открыть всё" onPress={() => canvas.current?.openAll()} /></View>
        <View style={{ flex: 1 }}><Button v="secondary" title="Закрыть" onPress={() => canvas.current?.closeAll()} /></View>
      </View>
    </View>
  );
}
