/** Несколько текстур EMAN внутри приложения: мок-режим работает без сети (assets/textures). */
import type { ImageSourcePropType } from 'react-native';

export const BUNDLED_TEXTURES: Record<string, ImageSourcePropType> = {
  'ldsp_16_egger_analog_af800_st9': require('../../assets/textures/ldsp_16_egger_analog_af800_st9.jpg'),
  'ldsp_16_egger_f204_st9': require('../../assets/textures/ldsp_16_egger_f204_st9.jpg'),
  'ldsp_16_egger_f637_st16': require('../../assets/textures/ldsp_16_egger_f637_st16.jpg'),
  'ldsp_16_egger_f186_st9': require('../../assets/textures/ldsp_16_egger_f186_st9.jpg'),
  'ldsp_16_egger_af416_st10': require('../../assets/textures/ldsp_16_egger_af416_st10.jpg'),
  'ldsp_16_egger_f433_st10': require('../../assets/textures/ldsp_16_egger_f433_st10.jpg'),
  'ldsp_16_egger_au325_st9': require('../../assets/textures/ldsp_16_egger_au325_st9.jpg'),
  'ldsp_16_egger_h1303_st12': require('../../assets/textures/ldsp_16_egger_h1303_st12.jpg'),
  'ldsp_16_egger_h1312_st10': require('../../assets/textures/ldsp_16_egger_h1312_st10.jpg'),
  'ldsp_16_egger_h1316_st17': require('../../assets/textures/ldsp_16_egger_h1316_st17.jpg'),
  'ldsp_16_egger_h1318_st10': require('../../assets/textures/ldsp_16_egger_h1318_st10.jpg'),
  'ldsp_16_egger_f187_st9': require('../../assets/textures/ldsp_16_egger_f187_st9.jpg'),
};
