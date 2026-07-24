# Fase 4 — UI + navegación

## Objetivo

El modelo de navegación (con íconos de tab bar), las pantallas core, el onboarding, los componentes propios y la superficie de auth COMPLETA. Esta fase es donde la app gana su CARÁCTER: después, las fases solo recolorean y animan.

## Protocolo

1. **Auth completa, no solo login.** Además de sign-up/sign-in/sign-out: forgot/reset password, change password y borrado de cuenta in-app. El borrado de cuenta es OBLIGATORIO para cualquier app con creación de cuenta (guideline 5.1.1(v) de Apple). Planea el reset temprano; OTP por código evita la complejidad de deep-links.
2. **Carácter estructural en gris.** Construye una escala tipográfica real (jerarquía de peso/tamaño, no plana), ritmo de espaciado deliberado y el elemento de firma estructural AHORA, todo bajo paleta NEUTRA (cero decisiones de color). Carácter estructural no es color: tipografía, composición, iconografía y craft de empty states se construyen aquí, en gris. Una fase 4 con pantallas planas, de peso uniforme y fuente del sistema es fallo de gate aunque los flujos funcionen.
3. **Solo primitivos en pantallas.** Nunca `Pressable` ni `TextInput` directo para un control estándar: si un primitivo no calza, extiéndelo en `components/ui/*`. Extrae cualquier patrón usado en 2+ lugares a un componente propio.
4. **Refinamiento UX/UI (ciclo con el usuario).** Tras el primer recorrido, itera sobre ergonomía de navegación, defaults, empty states, copy de error y conteo de taps del core loop; audita la densidad de información y re-jerarquiza pantallas saturadas (progressive disclosure). Cero identidad visual: la paleta neutra se queda.

## Skills

- `expo-runtime`, `rn-performance` — runtime y performance de RN.
- `app-ia`, `impeccable` (primaria, carga y APLICA), `bolder`, `react-19`, `typescript`, `ponytail` — si alguna de estas skills no está instalada en tu motor (no aparece en tu catálogo de skills disponibles), continúa sin ella o instálala antes de arrancar la fase; Argos no valida automáticamente disponibilidad de skills externas por fase.

## Cómo verificar el gate

- El usuario recorre TODOS los flujos y funcionan; confirma que las pantallas leen claras y ya tienen personalidad estructural en gris.
- `rg -n "Pressable|TextInput" app/ --glob '!components/ui/*'` devuelve cero.
- `rg -n "height: [0-9]|paddingVertical: [0-9]" app/` no muestra styling de control fuera de `components/ui/*`. Cualquier hit es fallo de gate automático.

## Artifacts

- `app/*` (rutas, nav, auth), `components/ui/*` extendido.
- Engram: `app/{app}/phase-4`.

## Modelo

`sonnet`, effort alto: aquí decide el juicio de diseño.
