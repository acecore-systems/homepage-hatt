import {
  defineConfig,
  presetAttributify,
  presetIcons,
  presetTypography,
  presetUno,
} from 'unocss'

export default defineConfig({
  presets: [
    presetUno(),
    presetAttributify(),
    presetTypography(),
    presetIcons({
      collections: {
        lucide: () =>
          import('@iconify-json/lucide/icons.json').then((i) => i.default),
      },
    }),
  ],
  theme: {
    colors: {
      ink: {
        50: '#f7f8fb',
        100: '#e7ebf2',
        300: '#a8b0bf',
        500: '#657085',
        700: '#30384a',
        900: '#151a24',
      },
      paper: '#fbfbf7',
      cyan: '#9fd8e3',
      mint: '#8fd8c2',
      ember: '#d95c4a',
      pollen: '#e9bc4d',
    },
    fontFamily: {
      sans: ['Noto Sans JP', 'system-ui', 'sans-serif'],
    },
  },
})
